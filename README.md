# DupliScan

DupliScan is a browser-based duplicate file finder for `.pdf`, `.txt`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, and `.pptx`.

It detects duplicates by file content using SHA-256, not filenames, and runs entirely in the browser UI.

## Stack

- Frontend: plain HTML, CSS, JavaScript
- Backend: FastAPI

## Run locally

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Start the app:

```bash
uvicorn main:app --reload
```

3. Open:

```text
http://127.0.0.1:8000
```

## Deploy

GitHub stores the code, but it does not run FastAPI by itself. The usual flow is:

1. Push this repo to GitHub.
2. Connect the GitHub repo to a Python host like Render, Railway, or Fly.io.
3. Use this start command:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Notes

- Folder scanning uses the File System Access API, so Chrome or Edge is recommended.
- Files are processed in the browser for duplicate detection.
