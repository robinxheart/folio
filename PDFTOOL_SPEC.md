# PDF Toolkit Web App (local)

## Goal
A local website for everyday PDF tasks for a college student (assignments, notes, lab records).
The frontend is plain HTML, CSS and JavaScript. The backend is a small Python server that runs
only on this machine (Windows). Nothing is uploaded to the internet.

## Features

**Core**
- Merge several PDFs into one
- Split a PDF into single pages or into parts by page ranges
- Extract pages (keep only chosen pages)
- Delete pages
- Info: page count, file size, metadata

**Editing**
- Rotate all pages or chosen pages
- Images to PDF (jpg, jpeg, png, bmp, webp), with drag to reorder
- Extract text (show on screen or download as .txt), warn if the PDF looks scanned
- Compress (lossless)

**Security**
- Lock (add a password)
- Unlock (remove a password, user supplies it)

**Convert to PDF**
- Word (.doc, .docx), PowerPoint (.ppt, .pptx), Excel (.xls, .xlsx), OpenDocument (.odt, .odp, .ods),
  .rtf, .csv, .txt, .html, .md, and images

**Optional later**
- Watermark text, page numbers, reorder pages, PDF to images, OCR for scanned PDFs,
  strong compression with Ghostscript, batch mode

## Stack
- Backend: Python 3.10+, Flask (or FastAPI), pypdf, Pillow
- Conversion: LibreOffice headless (`soffice.exe`), with Microsoft Word via `docx2pdf` as the preferred path for .doc and .docx when Word is installed
- Frontend: vanilla HTML, CSS, JavaScript (`fetch` + `FormData`), no framework
- Optional: pdf.js for page previews (bundle locally)

## Project structure
```
pdftool/
  server.py          # routes + startup
  pdf_ops.py         # merge, split, extract, delete, rotate, compress, lock, unlock, text, info
  convert.py         # Word/PPT/Excel/images/md to PDF
  static/
    index.html
    style.css
    app.js
  temp/              # uploaded + output files, cleaned automatically
  requirements.txt
```

## Page range format
1-based. `"1-3,5,8-"` means pages 1 to 3, page 5, and page 8 to the end.
Reject ranges that are out of bounds with a clear message.

## Server rules
- Bind to `127.0.0.1` only, never `0.0.0.0`
- Serve the frontend from the same Flask app (avoids CORS problems)
- Endpoints (POST, multipart form data, return the PDF or a ZIP as a download):
  `/api/merge`, `/api/split`, `/api/extract`, `/api/delete`, `/api/rotate`,
  `/api/compress`, `/api/lock`, `/api/unlock`, `/api/images-to-pdf`, `/api/convert`
- `/api/text` and `/api/info` return JSON
- Save uploads in `temp/` with random names (uuid) and sanitize filenames
- Delete temp files after the response is sent, and clean files older than 1 hour on startup
- Limit upload size (default 100 MB) and allow only known extensions
- Return JSON errors with a clear message and a proper status code
  (bad page range, password-protected file, unsupported type, converter missing)
- Never modify or overwrite the original upload

## Convert to PDF (Windows)
Converter order by file type:
- `.doc`, `.docx`: try `docx2pdf` (needs Microsoft Word). If Word is missing or it fails, fall back to LibreOffice.
- `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.odt`, `.odp`, `.ods`, `.rtf`, `.csv`, `.txt`, `.html`: LibreOffice headless
- Images: reuse the images-to-PDF function (Pillow)
- `.md`: use `pandoc` if installed, otherwise LibreOffice

LibreOffice handling:
- Find `soffice.exe` by checking, in order: `shutil.which("soffice")`,
  `C:\Program Files\LibreOffice\program\soffice.exe`,
  `C:\Program Files (x86)\LibreOffice\program\soffice.exe`
- Run with `subprocess.run([...], timeout=120)`:
  `soffice --headless --convert-to pdf --outdir <dir> <file>`
- Add `-env:UserInstallation=file:///C:/Temp/lo_profile` so it does not clash with an open LibreOffice window
- Run only one conversion at a time (use a lock)
- If no converter is found, return a clear error with install instructions
  (`winget install TheDocumentFoundation.LibreOffice`) instead of crashing

Word via COM:
- `docx2pdf` uses COM. In a Flask worker thread call `pythoncom.CoInitialize()` first and
  `pythoncom.CoUninitialize()` after, or conversions will fail randomly.
- Skip Word lock files such as `~$report.docx`
- Password-protected Office files cannot be converted unattended, so return a clear error

## Frontend
- Single page with a card or tab per tool (Merge, Split, Extract, Delete, Rotate, Compress,
  Lock/Unlock, Images to PDF, Convert to PDF, Text, Info)
- Drag-and-drop zone plus a normal file picker, showing file name and size
- Merge and Images-to-PDF: reorder files by dragging
- Page range input with a hint ("1-3,5,8-") and validation
- Loading state while the server works, and the button disabled to prevent double submit
- Result shown as a download button; errors shown in a clear message box
- Responsive layout, clean design, dark mode toggle
- No external CDN dependencies (bundle any library locally)

## Build in phases (finish and test each before the next)
1. Server skeleton, static page, and merge + info working end to end
2. Split, extract, delete, rotate, images to PDF
3. Convert to PDF (LibreOffice first, then Word via docx2pdf as the preferred path for .doc/.docx)
4. Compress, lock, unlock, text extraction
5. Polish: drag-reorder, page thumbnails with pdf.js, dark mode, temp cleanup

## Run
```
pip install -r requirements.txt
python server.py
```
Then open http://localhost:5000 (optionally auto-open the browser with `webbrowser.open`).

`requirements.txt`:
```
flask
pypdf
pillow
docx2pdf
pywin32
```

## Done when
- Every tool works from the browser on a normal PDF, a password-protected PDF, and a .docx file
- Errors show clearly in the page
- Temp files do not pile up
- The server is reachable only from this machine
