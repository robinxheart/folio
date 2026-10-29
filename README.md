# Folio — a local PDF toolkit

Folio is a small, private web app for everyday PDF work. It runs on your own
machine, opens in your browser, and never sends a file anywhere: the server
binds to `127.0.0.1` only. Ten tools, one shelf — the shelf is the home
screen, and each of its ten volumes opens one tool:

| Group | Tool | What it does |
| --- | --- | --- |
| Organize | **Merge** | Combine PDFs in the order you arrange them |
| | **Split** | Cut a PDF into parts at lines you click, or one file per page |
| | **Pages** | Take chosen pages out (Extract), or take them away (Delete) — one view, two tabs |
| Edit | **Rotate** | Turn chosen pages by 90°, 180° or 270° |
| | **Compress** | Shrink a PDF (lossless, or Strong with an image-quality trade-off) |
| | **Text** | Read the words (Read), or rewrite them in place (Edit) — edits queue until you save |
| | **Watermark** | Stamp text or a picture across the pages of a copy |
| Protect | **Protect** | Add a password (Lock), or make a copy that opens without one (Unlock) |
| Convert | **To PDF** | Turn Word, Excel, PowerPoint, image and a few other files into PDFs |
| Inspect | **Info** | File details: pages, size, version, title and metadata |

### Text > Edit, in brief

The Edit tab shows the page at full size with its text lines as clickable
boxes. Changes queue in a list (undo, redo, revert per line) and nothing is
written until **Save PDF**: the original line is removed and the new text is
drawn with the matched font, or the closest bundled face (a note tells you
when a font was substituted). Deleting a line removes it from the file for
good. Edits work on real text only — a scan has nothing to edit, and a
locked file asks for its password first. The page scrolls and zooms on a
phone; for precise edits a larger screen works best.

## Run it

```
pip install -r requirements.txt
python server.py
```

Then open **http://localhost:5000** (the server opens it for you). Stop with
Ctrl+C in the terminal. Set `FOLIO_NO_BROWSER=1` to skip the auto-open.

Requirements: Python 3.11+ with Flask, pypdf, PyMuPDF, Pillow, pywin32 and
cryptography (`requirements.txt` has all of them). Thumbnails are drawn by a
bundled pdf.js — no CDN access needed, everything is local.

## Supported file types

- **PDF tools** (everything except To PDF): `.pdf`, including files locked
  with a password (Unlock asks for it, the rest tell you the file is locked).
- **Convert to PDF**, via the Office apps installed on this machine:
  - Word: `.doc` `.docx` `.rtf` `.txt` `.html` `.htm` `.odt`
  - Excel: `.xls` `.xlsx` `.xlsm` `.csv` `.ods`
  - PowerPoint: `.ppt` `.pptx` `.odp`
  - Images (no Office needed): `.jpg` `.jpeg` `.png` `.bmp` `.webp`
  - Markdown: `.md` (through pandoc if installed, otherwise as plain text via Word)
- Uploads are capped at **100 MB** per file; the page tells you before
  anything is sent if a file is larger.

## Office conversion troubleshooting

Convert to PDF drives the Word/Excel/PowerPoint installed on this machine
through Windows COM, in a separate worker process, one conversion at a time,
with a 120-second timeout.

- **"Word, Excel and PowerPoint found" vs "Office not found"** — Folio checks
  the registry at startup. If conversion says Office is missing, make sure a
  desktop Office (Microsoft 365 or a perpetual licence) is installed and has
  been opened once. Store/UWP-only Office and Office on the web don't expose
  the COM interface Folio needs.
- **A conversion hangs or fails** — close any Office dialog left open (a
  licence prompt, a "file in use" notice), then try again. The worker kills
  its own Office instance on timeout; your open documents are never touched.
- **A file converts wrong** (odd layout, missing fonts) — open it in the
  source app once and export manually; Folio uses the same engine, so a
  document Office can't lay out won't convert better here.
- **`.odt` / `.ods` / `.odp`** — these go through Office's OpenDocument
  support. If an OpenDocument file fails, open and re-save it in Office once.
- **One at a time** — conversions are serialised on purpose (Office COM is
  not safe in parallel). A second file waits; the page shows the queue.

## Privacy & housekeeping

- The server binds to `127.0.0.1` only — no other machine can reach it.
- Nothing is stored: each response's temporary files are deleted as soon as
  the reply is sent, and any leftovers older than an hour are swept when the
  server starts.
- Files never leave your machine; there are no analytics, no CDN requests.

## Layout of this folder

```
server.py          Flask app + API endpoints (also 127.0.0.1-only binding)
pdf_ops.py         the PDF operations (pypdf)
pymupdf_ops.py     watermark and text editing (PyMuPDF)
convert_ops.py     Office conversion orchestration
convert_worker.py  the per-conversion worker process
static/            the single-page interface (vanilla JS, bundled pdf.js)
static/shelf/      the shelf home: the 3D scene, its styles and the painted covers
static/vendor/     pdf.js and three.js, bundled locally
static/fonts/      Bricolage Grotesque, Instrument Sans, Inter, EB Garamond,
                   and the DejaVu faces the watermark and text edits embed
samples/           example files used by the ?demo=1 preview
temp/              scratch space, always empty outside a request
```

## The shelf is the home screen

Opening Folio lands on the **shelf**: ThreeUI's *Ashen Press* scene — ten
volumes on oak shelves, rendered with three.js, one volume per tool. It is
the one deliberate exception to Folio's flat, quiet look (see `DESIGN.md`,
"Shelf home"). The scene is the canonical ThreeUI source, ported verbatim;
the covers are Folio's own painted artwork — cloth in the group's colour,
one geometric emblem per tool, the tool name embossed front and spine.
Hover lifts a spine, click takes a volume down, drag turns it in the hand,
and the copy slides in over a torn paper edge; the panel's **Open** button
starts that tool. A slim top bar (wordmark, "Shelf" button, theme toggle)
rides along inside every tool view, and the browser's Back always returns
to the shelf.

- **Loaded once, paused when hidden**: three.js and the scene load at
  startup, just after the shell paints. Opening a tool (or hiding the tab)
  pauses the animation loop; the scene stays in memory, so coming back is
  instant and the tools stay exactly as fast as before.
- **Keyboard**: Tab to the scene, arrows move between volumes, Enter takes
  a volume down or turns it over, Escape puts it back. The ten tools are
  also listed as plain links for screen readers. `prefers-reduced-motion`
  gets a calm, mostly static scene with instant state changes.
- **Deep links**: every tool has a hash route — `#/merge`, `#/protect`,
  `#/protect/unlock`, `#/text`, `#/text/edit`, `#/watermark`, `#/info` — and
  old `?tool=` links redirect to them.
- **Offline**: Three.js r181, both fonts and every texture are bundled
  under `static/`; the page makes no request outside `127.0.0.1`.
- **Fallback**: without WebGL the shelf frame steps aside and the same ten
  tools appear as a plain list of links in Folio's chrome.

## Bundled software and licences

| Software | Licence | Where |
| --- | --- | --- |
| pdf.js | Apache-2.0 | `static/vendor/pdf.min.js`, `pdf.worker.min.js` |
| three.js r181 | MIT | `static/vendor/three.module.js` |
| Ashen Press scene | MIT (ThreeUI) | `static/shelf/shelf.js`, `static/shelf/shelf.css` |
| Lucide icons | ISC | inline SVG sprite in `static/index.html` |
| Bricolage Grotesque | SIL OFL 1.1 | `static/fonts/bricolage-grotesque-latin.woff2` |
| Instrument Sans | SIL OFL 1.1 | `static/fonts/instrument-sans-latin.woff2` |
| Inter | SIL OFL 1.1 | `static/fonts/inter-variable.woff2` |
| EB Garamond | SIL OFL 1.1 | `static/fonts/eb-garamond-*.woff2` |
| DejaVu fonts | Bitstream Vera + Arev (permissive) | `static/fonts/DejaVu*.ttf`, `static/fonts/LICENSE_DEJAVU` |

Folio itself runs on **PyMuPDF** (the watermark and text-editing engine),
which is licensed **AGPL-3.0**. Using Folio locally for your own files
carries no obligations. If you distribute Folio (or a version of it) to
others, the AGPL requires that you offer that combined work's source under
AGPL-3.0 as well — keep this folder complete, including
`static/fonts/LICENSE_DEJAVU`.

Three.js copyright notice (MIT): Copyright © 2010-2025 three.js authors.
The Ashen Press scene © ThreeUI, redistributed under its MIT licence. The
covers, spines and back plates painted inside the scene are Folio's own
canvas artwork, drawn at boot by `static/shelf/shelf.js`; ThreeUI's
generated plates were removed with the game material they depicted.
