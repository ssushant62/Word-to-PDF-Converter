const MAX_FILE_SIZE = 25 * 1024 * 1024;

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const browseButton = document.querySelector('#browse-button');
const fileCard = document.querySelector('#file-card');
const fileName = document.querySelector('#file-name');
const fileSize = document.querySelector('#file-size');
const removeFileButton = document.querySelector('#remove-file');
const convertButton = document.querySelector('#convert-button');
const downloadButton = document.querySelector('#download-button');
const anotherButton = document.querySelector('#another-button');
const message = document.querySelector('#message');

let selectedFile = null;
let downloadUrl = null;
let downloadFilename = null;
let busy = false;

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message${type ? ` ${type}` : ''}`;
}

function isDocx(file) {
  return file.name.toLowerCase().endsWith('.docx');
}

function chooseFile(file) {
  if (!file) return;
  clearResult();
  if (!isDocx(file)) {
    selectedFile = null;
    fileInput.value = '';
    fileCard.hidden = true;
    convertButton.disabled = true;
    setMessage('Please choose a Word document in .docx format.', 'error');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    selectedFile = null;
    fileInput.value = '';
    fileCard.hidden = true;
    convertButton.disabled = true;
    setMessage('That file is larger than the 25 MB limit. Choose a smaller document.', 'error');
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileCard.hidden = false;
  dropZone.hidden = true;
  convertButton.disabled = false;
  setMessage('');
}

function clearResult() {
  downloadUrl = null;
  downloadFilename = null;
  downloadButton.hidden = true;
  anotherButton.hidden = true;
  convertButton.hidden = false;
  convertButton.classList.remove('is-loading');
}

function resetConverter() {
  selectedFile = null;
  fileInput.value = '';
  fileCard.hidden = true;
  dropZone.hidden = false;
  convertButton.disabled = true;
  convertButton.hidden = false;
  downloadButton.hidden = true;
  anotherButton.hidden = true;
  convertButton.classList.remove('is-loading');
  downloadButton.classList.remove('is-loading');
  setMessage('');
}

async function convertFile() {
  if (!selectedFile || busy) return;
  busy = true;
  convertButton.disabled = true;
  convertButton.classList.add('is-loading');
  setMessage('Uploading your document and converting it locally…');

  const formData = new FormData();
  formData.append('file', selectedFile);
  try {
    const response = await fetch('/api/convert', { method: 'POST', body: formData });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Conversion failed. Please try again.');
    }

    downloadUrl = result.downloadUrl;
    downloadFilename = result.filename;
    convertButton.hidden = true;
    downloadButton.hidden = false;
    anotherButton.hidden = false;
    setMessage('Your PDF is ready to download.', 'success');
  } catch (error) {
    setMessage(error.message || 'Something went wrong. Please try again.', 'error');
    convertButton.disabled = false;
  } finally {
    busy = false;
    convertButton.classList.remove('is-loading');
  }
}

async function downloadPdf() {
  if (!downloadUrl || busy) return;
  busy = true;
  downloadButton.disabled = true;
  downloadButton.classList.add('is-loading');
  setMessage('Preparing your download…');
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'The PDF download is no longer available. Convert the document again.');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = downloadFilename || 'converted-document.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    downloadUrl = null;
    downloadButton.hidden = true;
    setMessage('Download started. Your temporary files have been removed.', 'success');
  } catch (error) {
    setMessage(error.message || 'The PDF could not be downloaded. Please convert again.', 'error');
  } finally {
    busy = false;
    downloadButton.disabled = false;
    downloadButton.classList.remove('is-loading');
  }
}

browseButton.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', (event) => {
  if (event.target !== browseButton) fileInput.click();
});

dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
removeFileButton.addEventListener('click', resetConverter);
convertButton.addEventListener('click', convertFile);
downloadButton.addEventListener('click', downloadPdf);
anotherButton.addEventListener('click', resetConverter);

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}

dropZone.addEventListener('drop', (event) => {
  chooseFile(event.dataTransfer.files[0]);
});
