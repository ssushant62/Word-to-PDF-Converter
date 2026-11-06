const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const JOB_TTL_MS = 15 * 60 * 1000;
const STALE_DIRECTORY_AGE_MS = JOB_TTL_MS;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const CONVERSION_TIMEOUT_MS = 90 * 1000;
const MAX_CONCURRENT_CONVERSIONS = 3;
const TEMP_PREFIX = 'word-to-pdf-converter-';
const jobs = new Map();
let activeConversions = 0;

app.disable('x-powered-by');
app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));

function safePdfFilename(originalname) {
  const portableName = String(originalname || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  let base = path.parse(portableName || '').name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100);

  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = 'converted-document';
  }
  return `${base}.pdf`;
}

function getLibreOfficeCandidates() {
  const candidates = [];
  const configuredPath = process.env.LIBREOFFICE_PATH;
  if (configuredPath) {
    candidates.push(path.resolve(configuredPath));
  }

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      path.join(programFiles, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(programFilesX86, 'LibreOffice', 'program', 'soffice.exe')
    );
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'LibreOffice', 'program', 'soffice.exe'));
    }
  } else {
    candidates.push('/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice');
  }

  return [...new Set(candidates)];
}

async function findLibreOffice() {
  for (const candidate of getLibreOfficeCandidates()) {
    try {
      const stat = await fsPromises.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Continue through known installation locations.
    }
  }
  return null;
}

async function removeDirectory(directory) {
  if (!directory) {
    return;
  }
  try {
    await fsPromises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.error('Temporary conversion directory cleanup failed:', error.message);
  }
}

async function cleanupStaleDirectories() {
  const entries = await fsPromises.readdir(os.tmpdir(), { withFileTypes: true });
  const cutoff = Date.now() - STALE_DIRECTORY_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) {
      continue;
    }
    const directory = path.join(os.tmpdir(), entry.name);
    const stat = await fsPromises.stat(directory);
    if (stat.mtimeMs < cutoff) {
      await removeDirectory(directory);
    }
  }
}

function prepareConversion(req, res, next) {
  if (activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
    return res.status(429).json({
      error: 'The converter is busy. Please wait for another conversion to finish and try again.'
    });
  }

  activeConversions += 1;
  req.conversionSlotHeld = true;
  fsPromises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
    .then((directory) => {
      req.conversionDir = directory;
      next();
    })
    .catch((error) => {
      releaseConversionSlot(req);
      next(error);
    });
}

function releaseConversionSlot(req) {
  if (req.conversionSlotHeld) {
    activeConversions -= 1;
    req.conversionSlotHeld = false;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      callback(null, req.conversionDir);
    },
    filename(req, file, callback) {
      callback(null, 'document.docx');
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 0,
    parts: 1
  },
  fileFilter(req, file, callback) {
    if (path.extname(file.originalname).toLowerCase() !== '.docx') {
      callback(new UploadInputError('Only .docx Word documents are supported.'));
      return;
    }
    callback(null, true);
  }
});

function runLibreOffice(executable, inputPath, outputDirectory, profileDirectory) {
  return new Promise((resolve, reject) => {
    const profileUrl = pathToFileURL(profileDirectory).href;
    const args = [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${profileUrl}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outputDirectory,
      inputPath
    ];
    let output = '';
    let timedOut = false;
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CONVERSION_TIMEOUT_MS);

    const capture = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new ConversionError('CONVERSION_TIMEOUT', 'The conversion took too long.'));
      } else if (code !== 0) {
        reject(new ConversionError('CONVERSION_FAILED', 'LibreOffice could not convert this document.', output));
      } else {
        resolve();
      }
    });
  });
}

class UploadInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadInputError';
  }
}

class ConversionError extends Error {
  constructor(code, message, diagnostic = '') {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

app.post('/api/convert', prepareConversion, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new UploadInputError('Choose a .docx file to convert.');
    }

    const signature = Buffer.alloc(4);
    const handle = await fsPromises.open(req.file.path, 'r');
    try {
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new UploadInputError('This file is not a valid DOCX document.');
    }

    const executable = await findLibreOffice();
    if (!executable) {
      throw new ConversionError('LIBREOFFICE_NOT_FOUND', 'LibreOffice is not installed or could not be located.');
    }

    const outputPath = path.join(req.conversionDir, 'document.pdf');
    const profileDirectory = path.join(req.conversionDir, 'lo-profile');
    await fsPromises.mkdir(profileDirectory);
    await runLibreOffice(executable, req.file.path, req.conversionDir, profileDirectory);

    const outputStat = await fsPromises.stat(outputPath).catch(() => null);
    if (!outputStat || !outputStat.isFile() || outputStat.size === 0) {
      throw new ConversionError('CONVERSION_FAILED', 'LibreOffice did not produce a PDF.');
    }

    const id = randomUUID();
    const filename = safePdfFilename(req.file.originalname);
    jobs.set(id, {
      directory: req.conversionDir,
      outputPath,
      filename,
      expiresAt: Date.now() + JOB_TTL_MS
    });
    req.keepConversionDir = true;
    res.status(201).json({ id, filename, downloadUrl: `/api/download/${id}` });
  } catch (error) {
    if (error instanceof ConversionError && error.diagnostic) {
      console.error('LibreOffice conversion diagnostic:', error.diagnostic);
    } else if (!(error instanceof UploadInputError)) {
      console.error('Document conversion failed:', error.message);
    }
    next(error);
  } finally {
    releaseConversionSlot(req);
    if (!req.keepConversionDir) {
      await removeDirectory(req.conversionDir);
    }
  }
});

app.get('/api/download/:id', async (req, res, next) => {
  const job = jobs.get(req.params.id);
  if (!job || job.expiresAt <= Date.now()) {
    if (job) {
      jobs.delete(req.params.id);
      await removeDirectory(job.directory);
    }
    res.status(404).json({ error: 'This download is no longer available. Convert the document again.' });
    return;
  }

  res.download(job.outputPath, job.filename, async (error) => {
    jobs.delete(req.params.id);
    await removeDirectory(job.directory);
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'The requested endpoint was not found.' });
});

app.use(async (error, req, res, next) => {
  if (req.conversionSlotHeld) {
    releaseConversionSlot(req);
  }
  if (req.conversionDir && !req.keepConversionDir) {
    await removeDirectory(req.conversionDir);
  }

  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof UploadInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'The document exceeds the 25 MB file-size limit.'
      : 'The upload could not be accepted. Choose one .docx file and try again.';
    res.status(400).json({ error: message });
    return;
  }
  if (error instanceof ConversionError && error.code === 'LIBREOFFICE_NOT_FOUND') {
    res.status(503).json({
      error: 'LibreOffice was not found. Install LibreOffice or set LIBREOFFICE_PATH to soffice.exe, then restart the app.'
    });
    return;
  }
  if (error instanceof ConversionError) {
    const message = error.code === 'CONVERSION_TIMEOUT'
      ? 'The conversion timed out. Try a smaller or simpler document.'
      : 'Conversion failed. Check that the DOCX file opens correctly and try again.';
    res.status(422).json({ error: message });
    return;
  }

  console.error('Request failed:', error.message);
  res.status(500).json({ error: 'The server could not complete this request. Please try again.' });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) {
      jobs.delete(id);
      void removeDirectory(job.directory);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

async function startServer() {
  try {
    await cleanupStaleDirectories();
  } catch (error) {
    console.error('Stale temporary directory cleanup failed:', error.message);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Word-to-PDF Converter is running at http://${HOST}:${PORT}`);
  });
  const shutdown = () => {
    clearInterval(cleanupTimer);
    server.close(async () => {
      for (const [id, job] of jobs) {
        jobs.delete(id);
        await removeDirectory(job.directory);
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer();
