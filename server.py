"""Folio - a local PDF toolkit. Phase 1: merge + info.

Run:  python server.py   (opens http://localhost:5000, binds 127.0.0.1 only)
Set FOLIO_NO_BROWSER=1 to skip auto-opening the browser (used by tests).
"""

from __future__ import annotations

import io
import json
import os
import re
import socket
import threading
import time
import uuid
import webbrowser
import zipfile
from urllib.parse import quote

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge, UnsupportedMediaType

import convert_ops
import pdf_ops
import pymupdf_ops
from pdf_ops import ToolError

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
TEMP_DIR = os.path.join(ROOT, "temp")
SAMPLES_DIR = os.path.join(ROOT, "samples")

MAX_UPLOAD = 100 * 1024 * 1024  # 100 MB
TEMP_MAX_AGE = 60 * 60  # temp files older than 1 hour go at startup
PORT_RANGE = range(5000, 5005)

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # dev: never cache static files

# Anything that is not a unicode letter/digit, space, or a few safe
# punctuation marks becomes "_": names with emoji or control characters
# can't break a Content-Disposition header, and "résumé.pdf" survives.
SAFE_NAME = re.compile(r"[^\w .\-&()\[\]]", re.UNICODE)
NAME_MAX = 120


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def sanitize_name(name: str | None) -> str:
    """Keep an original-looking, safe display name for upload metadata.

    Unicode letters and digits survive; path parts, control characters
    and odd symbols become _; very long names are capped before the
    extension (the value flows into download names).
    """
    base = os.path.basename(name or "").strip()
    base = os.path.basename(base.replace("\\", "/").replace(":", "_"))
    cleaned = SAFE_NAME.sub("_", base).strip(" ._")
    if len(cleaned) > NAME_MAX:
        stem, ext = os.path.splitext(cleaned)
        cleaned = (stem[: NAME_MAX - len(ext)] + ext).strip(" ._")
    return cleaned or "file.pdf"


PDF_EXTS = (".pdf",)
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def _save_upload(storage, allowed: tuple = PDF_EXTS,
                 wrong: str | None = None, empty: str | None = None):
    """Save one uploaded file into temp/ under a random name.

    Returns (temp path, sanitized original name). Never rewrites or
    moves the original file. `wrong` / `empty` override the reject copy
    for tools whose panel accepts other file types (the convert tool).
    """
    original = storage.filename or ""
    display = sanitize_name(original)
    ext = os.path.splitext(display)[1].lower()
    shown = ext.lstrip(".") or "unknown"
    if ext not in allowed:
        if wrong is not None:
            raise ToolError(wrong.format(shown=shown))
        if allowed == PDF_EXTS:
            raise ToolError(f"Only PDF files work here. This one is a .{shown}.")
        raise ToolError(f"Only image files work here. This one is a .{shown}.")
    os.makedirs(TEMP_DIR, exist_ok=True)
    tmp = os.path.join(TEMP_DIR, uuid.uuid4().hex + ext)
    storage.save(tmp)
    if os.path.getsize(tmp) == 0:
        _delete(tmp)
        raise ToolError(empty or ("This PDF is empty."
                                  if allowed == PDF_EXTS and empty is None
                                  else "This image is empty."))
    return tmp, display


def _delete(path: str) -> None:
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _delete_all(paths) -> None:
    for p in paths:
        _delete(p)


def _finish_bytes(out_path: str, uploads=()) -> bytes:
    """Deterministic temp cleanup: read the output, delete everything,
    return the bytes. (Response-closed callbacks don't run the same way
    on the dev server, so relying on them left temp files behind.)"""
    with open(out_path, "rb") as fh:
        payload = fh.read()
    _delete(out_path)
    _delete_all(uploads)
    return payload


def _name_base(display: str) -> str:
    """'assignment.pdf' -> 'assignment', safe for download names."""
    base = os.path.splitext(display)[0].strip(" ._")
    return base or "document"


def _cleanup_temp_dir() -> None:
    """Startup sweep: remove temp files older than 1 hour."""
    os.makedirs(TEMP_DIR, exist_ok=True)
    now = time.time()
    for name in os.listdir(TEMP_DIR):
        path = os.path.join(TEMP_DIR, name)
        if os.path.isfile(path) and now - os.path.getmtime(path) > TEMP_MAX_AGE:
            _delete(path)


def _pick_port() -> int:
    """First free port in 5000-5004 (5000 preferred)."""
    for port in PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 5000


# --------------------------------------------------------------------------
# pages
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/samples/<path:name>")
def samples(name: str):
    """Sample files for the ?demo=1 preview helper and manual testing."""
    return send_from_directory(SAMPLES_DIR, name)


# --------------------------------------------------------------------------
# API - PDF in, PDF out (multipart/form-data, POST only)
# --------------------------------------------------------------------------

@app.post("/api/merge")
def api_merge():
    parts = request.files.getlist("files")
    if not parts:
        raise ToolError("No PDFs were sent. Choose files and try again.")

    uploads: list = []
    out_path = None
    try:
        for part in parts:
            uploads.append(_save_upload(part))
        out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
        pdf_ops.merge([p for p, _ in uploads], out_path)
    except ToolError:
        _delete(out_path)
        _delete_all([p for p, _ in uploads])
        raise

    payload = _finish_bytes(out_path, [p for p, _ in uploads])

    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True, download_name="merged.pdf")


@app.post("/api/extract")
def api_extract():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        pdf_ops.extract_pages(tmp, out_path, request.form.get("pages", ""))
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-extracted.pdf")


@app.post("/api/delete")
def api_delete():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        pdf_ops.delete_pages(tmp, out_path, request.form.get("pages", ""))
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-remaining.pdf")


@app.post("/api/rotate")
def api_rotate():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        degrees = int(request.form.get("degrees", "0") or 0)
    except ValueError:
        _delete(tmp)
        raise ToolError("Choose 90, 180 or 270 degrees.") from None
    try:
        pdf_ops.rotate_pages(tmp, out_path, request.form.get("pages", ""), degrees)
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-rotated.pdf")


@app.post("/api/split")
def api_split():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".zip")
    try:
        mode = request.form.get("mode", "parts")
        cuts = request.form.get("cuts", "")
        pdf_ops.split_pdf(tmp, out_path, cuts, mode, base=_name_base(display))
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/zip",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-split.zip")


@app.post("/api/images-to-pdf")
def api_images_to_pdf():
    parts = request.files.getlist("files")
    if not parts:
        raise ToolError("No image files were sent. Choose images and try again.")

    uploads: list = []
    out_path = None
    try:
        for part in parts:
            uploads.append(_save_upload(part, IMAGE_EXTS))
        out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
        pdf_ops.images_to_pdf([p for p, _ in uploads], out_path)
    except ToolError:
        _delete(out_path)
        _delete_all([p for p, _ in uploads])
        raise
    payload = _finish_bytes(out_path, [p for p, _ in uploads])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True, download_name="images.pdf")


# --------------------------------------------------------------------------
# API - convert (Word/Excel/PowerPoint + more -> PDF, via convert_ops)
# --------------------------------------------------------------------------

_CONVERT_WRONG_TYPE = ("Only Word, Excel, PowerPoint and image files work "
                       "here. This one is a .{shown}.")


@app.get("/api/converters")
def api_converters():
    """Which converter apps this machine has (drives the drop-zone note)."""
    return jsonify(convert_ops.check_converters())


@app.post("/api/convert")
def api_convert():
    parts = request.files.getlist("files")
    if not parts:
        raise ToolError("No files were sent. Choose files and try again.")

    converters = convert_ops.check_converters()
    uploads: list = []      # (temp path, display, lower ext), request order
    outputs: list = []      # one PDF per input (or one merged images PDF)
    try:
        for part in parts:
            if (part.filename or "").startswith("~$"):
                continue  # Office owner/lock file: skip silently
            tmp, display = _save_upload(
                part, convert_ops.CONVERT_EXTS,
                wrong=_CONVERT_WRONG_TYPE, empty="This file is empty.")
            ext = os.path.splitext(display)[1].lower()
            uploads.append((tmp, display, ext))
        if not uploads:
            raise ToolError("Nothing to convert.")

        def _new_temp(ext: str) -> str:
            return os.path.join(TEMP_DIR, uuid.uuid4().hex + ext)

        # Images only -> one merged PDF, in the order shown (Phase 2 flow).
        if all(ext in convert_ops.IMAGE_EXTS for _, _, ext in uploads):
            out = _new_temp(".pdf")
            outputs.append(out)
            pdf_ops.images_to_pdf([u[0] for u in uploads], out)
            payload = _finish_bytes(out, [u[0] for u in uploads])
            return send_file(
                io.BytesIO(payload), mimetype="application/pdf",
                as_attachment=True,
                download_name=f"{_name_base(uploads[0][1])}.pdf")

        # Any document present -> every file becomes its own PDF.
        for tmp, src_name, ext in uploads:
            out = _new_temp(".pdf")
            if ext in convert_ops.IMAGE_EXTS:
                pdf_ops.images_to_pdf([tmp], out)
            else:
                convert_ops.convert_one(
                    tmp, out, ext, _name_base(src_name), converters)
            outputs.append(out)

        if len(outputs) == 1:
            payload = _finish_bytes(outputs[0], [u[0] for u in uploads])
            return send_file(
                io.BytesIO(payload), mimetype="application/pdf",
                as_attachment=True,
                download_name=f"{_name_base(uploads[0][1])}.pdf")

        # Several files -> one ZIP; member names collide? add _1.
        members: list[str] = []
        used: set[str] = set()
        for _tmp, src_name, _ext in uploads:
            stem = _name_base(src_name)
            candidate = f"{stem}.pdf"
            n = 0
            while candidate in used:
                n += 1
                candidate = f"{stem}_{n}.pdf"
            used.add(candidate)
            members.append(candidate)
        zip_path = _new_temp(".zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for out, member in zip(outputs, members):
                archive.write(out, member)
        payload = _finish_bytes(zip_path, [u[0] for u in uploads] + outputs)
        return send_file(io.BytesIO(payload), mimetype="application/zip",
                         as_attachment=True, download_name="converted.zip")
    except ToolError:
        _delete_all(outputs)
        _delete_all([u[0] for u in uploads])
        raise
    except convert_ops.ConvertError as err:  # surgical: any convert failure
        _delete_all(outputs)
        _delete_all([u[0] for u in uploads])
        raise ToolError(str(err)) from None


@app.post("/api/info")
def api_info():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")

    tmp, display = _save_upload(storage)
    try:
        data = pdf_ops.info(tmp)
    finally:
        _delete(tmp)  # info builds a JSON reply; the file is done now
    data["name"] = display
    return jsonify(data)


# --------------------------------------------------------------------------
# API - compress, lock, unlock, text (single-file tools)
# --------------------------------------------------------------------------

@app.post("/api/compress")
def api_compress():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    level = (request.form.get("level") or "").strip().lower()
    if level not in ("standard", "strong"):
        raise ToolError("Choose a compression level and try again.")
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        stats = pdf_ops.compress_pdf(tmp, out_path, level)
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    resp = send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-compressed.pdf")
    resp.headers["X-Folio-Original"] = str(stats["original"])
    resp.headers["X-Folio-Result"] = str(stats["result"])
    if stats["unchanged"]:
        resp.headers["X-Folio-Unchanged"] = "1"
    return resp


@app.post("/api/lock")
def api_lock():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    password = request.form.get("password") or ""
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        pdf_ops.lock_pdf(tmp, out_path, password)
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    password = None  # used once; never logged, stored or echoed back
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-locked.pdf")


@app.post("/api/unlock")
def api_unlock():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    password = request.form.get("password")  # None = "not supplied yet" (423)
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    try:
        pdf_ops.unlock_pdf(tmp, out_path, password)
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    password = None  # used once; never logged, stored or echoed back
    payload = _finish_bytes(out_path, [tmp])
    return send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-unlocked.pdf")


@app.post("/api/text")
def api_text():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, _ = _save_upload(storage)
    try:
        data = pdf_ops.extract_text(tmp)
    finally:
        _delete(tmp)
    return jsonify(data)


# --------------------------------------------------------------------------
# API - watermark and text editing (PyMuPDF)
# --------------------------------------------------------------------------

@app.post("/api/watermark")
def api_watermark():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    img_tmp = None
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    notes: list[str] = []
    try:
        image = request.files.get("image")
        if image is not None and image.filename:
            img_tmp, _ = _save_upload(
                image, allowed=(".png", ".jpg", ".jpeg"),
                wrong="Watermark images work as PNG or JPG. This one is a .{shown}.",
                empty="This image is empty.")
        try:
            size = float(request.form.get("size") or 48)
            opacity = float(request.form.get("opacity") or 20) / 100
            angle = float(request.form.get("angle") or 45)
            margin = float(request.form.get("margin") or 36)
            scale = float(request.form.get("scale") or 30) / 100
        except ValueError:
            raise ToolError("Type numbers in the watermark options.") from None
        try:
            pymupdf_ops.watermark(
                tmp, out_path,
                text=request.form.get("text") or "",
                image_path=img_tmp,
                family=request.form.get("font") or "helvetica",
                size=size, colour=request.form.get("colour") or "#9aa0a6",
                opacity=opacity, angle=angle,
                position=request.form.get("position") or "centre",
                margin=margin, scale=scale,
                pages=request.form.get("pages", ""),
                behind=request.form.get("behind") == "1",
                password=request.form.get("password") or None,
                notes=notes)
        except ToolError:
            raise
        except Exception:
            app.logger.exception("watermark failed")
            raise ToolError("The watermark could not be added. Try again.", 500) from None
    except ToolError:
        _delete(out_path)
        _delete_all([tmp, img_tmp])
        raise
    payload = _finish_bytes(out_path, [tmp, img_tmp])
    resp = send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-watermarked.pdf")
    if notes:
        resp.headers["X-Folio-Notes"] = quote(json.dumps(notes))
    return resp


@app.post("/api/text-edit/spans")
def api_text_edit_spans():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    tmp, display = _save_upload(storage)
    try:
        data = pymupdf_ops.spans(tmp, password=request.form.get("password") or None)
    finally:
        _delete(tmp)
    data["name"] = display
    return jsonify(data)


@app.post("/api/text-edit/apply")
def api_text_edit_apply():
    storage = request.files.get("file")
    if storage is None:
        raise ToolError("No PDF was sent. Choose a file and try again.")
    try:
        edits = json.loads(request.form.get("edits") or "[]")
    except ValueError:
        raise ToolError("Something went wrong with the edit list. Try again.") from None
    tmp, display = _save_upload(storage)
    out_path = os.path.join(TEMP_DIR, uuid.uuid4().hex + ".pdf")
    notes: list[str] = []
    try:
        try:
            pymupdf_ops.apply_edits(tmp, out_path, edits, notes,
                                    password=request.form.get("password") or None)
        except ToolError:
            raise
        except Exception:
            app.logger.exception("text-edit apply failed")
            raise ToolError("The edits could not be saved. Try again.", 500) from None
    except ToolError:
        _delete(out_path)
        _delete(tmp)
        raise
    payload = _finish_bytes(out_path, [tmp])
    resp = send_file(io.BytesIO(payload), mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"{_name_base(display)}-edited.pdf")
    if notes:
        resp.headers["X-Folio-Notes"] = quote(json.dumps(notes))
    return resp


# --------------------------------------------------------------------------
# JSON errors everywhere
# --------------------------------------------------------------------------

@app.errorhandler(ToolError)
def on_tool_error(err: ToolError):
    return jsonify({"error": err.message}), err.status


@app.errorhandler(RequestEntityTooLarge)
def on_too_large(err):
    return jsonify({"error": "This upload is too large. The limit is 100 MB."}), 413


@app.errorhandler(UnsupportedMediaType)
def on_bad_media(err):
    return jsonify({"error": "Only PDF files work here. This one is a .unknown."}), 415


@app.errorhandler(HTTPException)
def on_http_error(err):
    return jsonify({"error": err.description}), err.code


@app.errorhandler(Exception)
def on_crash(err):
    app.logger.exception("Unhandled error")
    return jsonify({"error": "Something failed on the server. Try again."}), 500


# --------------------------------------------------------------------------
# startup
# --------------------------------------------------------------------------

def main():
    _cleanup_temp_dir()
    port = _pick_port()
    url = f"http://localhost:{port}"
    print(f"Folio running on {url}  (local only)")
    if os.environ.get("FOLIO_NO_BROWSER", "") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
