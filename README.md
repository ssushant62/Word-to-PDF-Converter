# Word-to-PDF Converter

A private, locally run web app for converting `.docx` documents to PDF with LibreOffice. Documents are sent only to the Express server on your own computer; no third-party conversion service is used.

## Requirements

- Windows 10 or 11
- Node.js 18 or newer
- LibreOffice installed on the computer

## Install and start

Open PowerShell in this project folder and run:

```powershell
npm install
npm start
```

Then open <http://127.0.0.1:3000> in your browser. The server listens only on the local loopback interface.

By default, the app looks for LibreOffice at:

- `C:\Program Files\LibreOffice\program\soffice.exe`
- `C:\Program Files (x86)\LibreOffice\program\soffice.exe`
- `%LOCALAPPDATA%\Programs\LibreOffice\program\soffice.exe`

For a custom installation, set `LIBREOFFICE_PATH` to the full path of `soffice.exe` before starting:

```powershell
$env:LIBREOFFICE_PATH = 'D:\Apps\LibreOffice\program\soffice.exe'
npm start
```

The environment variable can also be set to a different valid executable path. The server checks the configured path first, then the standard Windows locations.

## Use and test

1. Open the app and select or drag in a `.docx` file (maximum 25 MB).
2. Confirm the filename and size, then choose **Convert to PDF**.
3. When conversion succeeds, choose **Download PDF**. Use **Convert another document** to start again without reloading the page.

To test successfully, use a known-good DOCX document you are comfortable converting. The app does not include a sample document. You can also test validation by selecting a `.txt` or `.doc` file, and test the size limit with a DOCX larger than 25 MB. If LibreOffice is unavailable, conversion returns a clear installation/configuration message.

## Local storage, limits, and cleanup

- Uploaded files and LibreOffice's isolated profile are kept in a unique temporary folder under the operating system's temp directory.
- Uploads are limited to one `.docx` file of up to 25 MB per conversion.
- At most three conversions run concurrently; additional requests receive a busy response.
- Temporary folders for failed conversions are removed immediately. A successful conversion is retained until its PDF is downloaded, or for at most 15 minutes; expired jobs are cleaned up periodically, and leftovers older than that are pruned at startup after a crash.
- The server runs on `127.0.0.1`, uses fixed LibreOffice arguments without a shell, and does not use external conversion APIs.

## Troubleshooting

- **LibreOffice was not found:** Install LibreOffice, or set `LIBREOFFICE_PATH` as shown above. Restart the server after changing the setting.
- **Conversion failed:** Make sure the document opens in Word or LibreOffice and is not password-protected or damaged.
- **Port 3000 is already in use:** Set another port before starting, for example `$env:PORT = '3001'; npm start`, then open `http://127.0.0.1:3001`.
