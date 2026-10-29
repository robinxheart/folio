"""PDF operations for Folio.

Phase 1: merge + info. Phase 2 adds split, extract, delete, rotate and
images-to-PDF on top of the same helpers.

Every failure raises ToolError with a user-facing message in the copy
voice from DESIGN.md ("errors say what happened and what to do").
"""

from __future__ import annotations

import io
import os
import re
import zipfile

import pypdf
from PIL import Image, ImageOps
from pypdf.errors import EmptyFileError, PdfReadError


class ToolError(Exception):
    """A predictable failure: carries its message and HTTP status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# DESIGN.md copy-table lines that more than one operation needs.
_LOCKED_COPY = "This PDF is locked. Enter its password to continue."


def _open(path: str) -> pypdf.PdfReader:
    """Read a PDF, raising ToolError with a clear message on bad input."""
    try:
        reader = pypdf.PdfReader(path)
    except EmptyFileError:
        raise ToolError("This PDF is empty.")
    except (PdfReadError, OSError, ValueError):
        raise ToolError("This PDF can't be read. It may be damaged.")

    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception:  # noqa: BLE001 - pypdf raises assorted types here
            unlocked = pypdf.PasswordType.NOT_DECRYPTED
        if unlocked == pypdf.PasswordType.NOT_DECRYPTED:
            raise ToolError(_LOCKED_COPY)
    return reader


def merge(paths, out_path: str) -> str:
    """Merge PDFs in the given order into out_path. Returns out_path."""
    writer = pypdf.PdfWriter()
    for path in paths:
        try:
            writer.append(_open(path))
        except ToolError:
            raise
        except Exception:  # noqa: BLE001 - any page/field/parse error is "damaged"
            raise ToolError("This PDF can't be read. It may be damaged.")
    try:
        with open(out_path, "wb") as fh:
            writer.write(fh)
    except OSError:
        raise ToolError("The merged file could not be written on this machine.", 500)
    return out_path


_DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?")


def _norm_date(raw) -> str | None:
    """'D:20241024135907' -> '2024-10-24 13:59'. Missing -> None."""
    if raw in (None, ""):
        return None
    s = str(raw).strip()
    if s.startswith("D:"):
        s = s[2:]
    m = _DATE_RE.match(s)
    if not m:
        return str(raw)
    y, mo, d, h, mi, _se = m.groups()
    out = f"{y}-{mo}-{d}"
    if h:
        out += f" {h}:{mi or '00'}"
    return out


def _meta_get(info, key: str) -> str | None:
    if not info:
        return None
    value = info.get(key)
    if value in (None, ""):
        return None
    return str(value).strip()


def info(path: str) -> dict:
    """Page count, file size and metadata for one PDF."""
    reader = _open(path)
    fields = {}
    try:
        page_count = len(reader.pages)
    except Exception:  # noqa: BLE001 - damaged page tree
        raise ToolError("This PDF can't be read. It may be damaged.")

    meta = reader.metadata
    fields = {
        "title": _meta_get(meta, "/Title"),
        "author": _meta_get(meta, "/Author"),
        "subject": _meta_get(meta, "/Subject"),
        "keywords": _meta_get(meta, "/Keywords"),
        "creator": _meta_get(meta, "/Creator"),
        "producer": _meta_get(meta, "/Producer"),
        "created": _norm_date(_meta_get(meta, "/CreationDate")),
        "modified": _norm_date(_meta_get(meta, "/ModDate")),
    }
    header = reader.pdf_header or ""
    match = re.match(r"^%PDF-(\d+\.\d+)", header)
    return {
        "pages": page_count,
        "size": os.path.getsize(path),
        "encrypted": reader.is_encrypted,
        "version": match.group(1) if match else None,
        "metadata": fields,
    }


# --------------------------------------------------------------------------
# Phase 2: page ranges, split, extract, delete, rotate, images to pdf
# --------------------------------------------------------------------------

def _pages_word(count: int) -> str:
    """'1 page' / '8 pages' - used inside error copy."""
    return "1 page" if count == 1 else f"{count} pages"


_TOKEN = re.compile(r"(\d+)(?:-(\d*))?")


def parse_pages(spec: str | None, total: int) -> list[int]:
    """'1-3,5,8-' -> sorted 0-based page indices.

    1-based per the spec. An empty spec means "no pages chosen"; callers
    decide what that means (rotate: everything; extract/delete: ask first).
    """
    if spec is None or not str(spec).strip():
        return []

    indices: set[int] = set()
    for raw in str(spec).split(","):
        token = raw.strip()
        if not token:
            continue
        match = _TOKEN.fullmatch(token)
        if not match:
            raise ToolError(f'"{token}" is not a page range. Use 1-3,5,8-.')
        first = int(match.group(1))
        second_raw = match.group(2)
        if second_raw is None:          # "5"  - just that page
            second = first
        elif second_raw == "":          # "5-" - through the end
            second = total
        else:                           # "5-8"
            second = int(second_raw)
            if second < first:
                raise ToolError(f'"{token}" is not a page range. Use 1-3,5,8-.')
        if first < 1 or second > total:
            raise ToolError(
                f'"{token}" is outside this file. It has {_pages_word(total)}.')
        indices.update(range(first - 1, second))

    return sorted(indices)


def extract_pages(path: str, out_path: str, spec: str | None) -> int:
    """Write a PDF holding only the chosen pages. Returns their count."""
    reader = _open(path)
    total = len(reader.pages)
    pages = parse_pages(spec, total)
    if not pages:
        raise ToolError("Choose the pages to extract.")
    writer = pypdf.PdfWriter()
    for index in pages:
        writer.add_page(reader.pages[index])
    _write(writer, out_path)
    return len(pages)


def delete_pages(path: str, out_path: str, spec: str | None) -> int:
    """Write a PDF without the chosen pages. Returns the kept count."""
    reader = _open(path)
    total = len(reader.pages)
    gone = set(parse_pages(spec, total))
    if not gone:
        raise ToolError("Choose the pages to delete.")
    keep = [i for i in range(total) if i not in gone]
    if not keep:
        raise ToolError("This would leave no pages. Keep at least one.")
    writer = pypdf.PdfWriter()
    for index in keep:
        writer.add_page(reader.pages[index])
    _write(writer, out_path)
    return len(keep)


def rotate_pages(path: str, out_path: str, spec: str | None, degrees: int) -> int:
    """Turn chosen pages by degrees (90/180/270, +deg from current).

    Empty spec means every page. Returns how many pages turned.
    """
    if degrees not in (90, 180, 270):
        raise ToolError("Choose 90, 180 or 270 degrees.")
    reader = _open(path)
    total = len(reader.pages)
    pages = parse_pages(spec, total)
    if not pages:
        pages = list(range(total))
    writer = pypdf.PdfWriter()
    for index, page in enumerate(reader.pages):
        if index in set(pages):
            try:
                page.rotate(degrees)
            except Exception:  # noqa: BLE001 - odd rotations on odd files
                raise ToolError("This PDF can't be read. It may be damaged.")
        writer.add_page(page)
    _write(writer, out_path)
    return len(pages)


def split_pdf(path: str, out_path: str, cuts_spec: str | None, mode: str = "parts",
              base: str | None = None) -> int:
    """Split into parts at cut positions, or one file per page, into a ZIP.

    Cut positions are page numbers the cut sits AFTER, 1-based and taken
    from the strip UI ("2,5" = cut after page 2 and after page 5). `base`
    gives the ZIP member names their prefix (download names stay honest).
    Returns the number of parts inside the ZIP written to out_path.
    """
    reader = _open(path)
    total = len(reader.pages)
    if mode == "pages":
        bounds: list[list[int]] = [[i] for i in range(total)]
    else:
        cuts = _parse_cuts(cuts_spec, total)
        if not cuts:
            raise ToolError("Choose at least one cut line. Click between two pages.")
        bounds = []
        start = 0
        for cut in sorted(set(cuts)):
            bounds.append(list(range(start, cut)))
            start = cut
        bounds.append(list(range(start, total)))

    base = base or os.path.splitext(os.path.basename(path))[0] or "pages"
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as archive:
        for number, page_indices in enumerate(bounds, start=1):
            writer = pypdf.PdfWriter()
            for index in page_indices:
                writer.add_page(reader.pages[index])
            part = io.BytesIO()
            _write(writer, part, seek_bytes=True)
            first = page_indices[0] + 1
            last = page_indices[-1] + 1
            if len(page_indices) == 1:
                label = f"{base}-p{first}.pdf"
            else:
                label = f"{base}-p{first}-{last}.pdf"
            archive.writestr(label, part.getvalue())
    with open(out_path, "wb") as fh:
        fh.write(memory.getvalue())
    return len(bounds)


def _parse_cuts(cuts_spec: str | None, total: int) -> list[int]:
    """Cut positions as page indexes (1-based, 1..total-1). Empty spec -> []."""
    if cuts_spec is None or not str(cuts_spec).strip():
        return []
    cuts: list[int] = []
    for raw in str(cuts_spec).split(","):
        token = raw.strip()
        if not token:
            continue
        if not re.fullmatch(r"\d+", token):
            raise ToolError(f'"{token}" is not a page number.')
        value = int(token)
        if value < 1 or value > total - 1:
            raise ToolError(
                f'"{token}" is outside this file. It has {_pages_word(total)}.')
        cuts.append(value)
    return sorted(set(cuts))


def _write(writer: pypdf.PdfWriter, target, seek_bytes: bool = False) -> None:
    """Write a writer's bytes; target is a path or a memory stream."""
    try:
        if seek_bytes:
            writer.write(target)
            target.seek(0)
        else:
            with open(target, "wb") as fh:
                writer.write(fh)
    except OSError:
        raise ToolError("The result file could not be written on this machine.", 500)


# --------------------------------------------------------------------------
# Phase 4: compress, lock, unlock, text
# --------------------------------------------------------------------------

_WRONG_PASSWORD = "That password didn't work. Try again."
_NOT_LOCKED = "This PDF is not locked. It has no password to remove."
JPEG_QUALITY = 65          # Strong compression rebuilds photos at this quality
TARGET_DPI = 150           # Strong: photos above this get downscaled


def compress_pdf(path: str, out_path: str, level: str = "standard") -> dict:
    """Shrink a PDF. Standard is lossless; Strong also rebuilds photos.

    Returns {"original": bytes, "result": bytes, "unchanged": bool}.
    If compression would grow the file, the original bytes are (re)written
    untouched and unchanged=True.
    """
    reader = _open(path)
    original_size = os.path.getsize(path)
    writer = pypdf.PdfWriter()
    try:
        writer.append(reader)
        if level == "strong":
            # Rebuild the photos first so the identical-objects pass that
            # follows can prune the original heavy image as an orphan.
            _strong_compress_images(writer)
        writer.compress_identical_objects(remove_identicals=True,
                                          remove_orphans=True)
        for page in writer.pages:
            try:
                page.compress_content_streams()
            except Exception:  # noqa: BLE001 - one odd page must not sink the file
                pass  # keep the stream as it came
    except ToolError:
        raise
    except Exception:  # noqa: BLE001 - odd pages/objects on odd files
        raise ToolError("This PDF can't be read. It may be damaged.") from None

    try:
        with open(out_path, "wb") as fh:
            writer.write(fh)
    except OSError:
        raise ToolError("The result file could not be written on this machine.", 500)
    writer_size = os.path.getsize(out_path)
    if writer_size >= original_size:
        # Return the original unchanged rather than a bigger file.
        with open(path, "rb") as src, open(out_path, "wb") as dst:
            dst.write(src.read())
        return {"original": original_size, "result": original_size,
                "unchanged": True}
    return {"original": original_size, "result": writer_size,
            "unchanged": False}


def _strong_compress_images(writer: pypdf.PdfWriter) -> None:
    """Rebuild big embedded photos: JPEG quality 65, above 150 dpi downscale.

    Replaces the image XObject each photo already has a resource entry for;
    any photo that can't be decoded stays exactly as it was.
    """
    for page in writer.pages:
        try:
            scales = _image_draw_scales(page)
            keys = list(page.images.keys())
        except Exception:  # noqa: BLE001 - stop at the first oddity
            continue
        for name in keys:
            try:
                img_file = page.images[name]
                pil = img_file.image
                if pil is None:
                    continue
                _replace_image(writer, page, name, img_file, pil, scales.get(name))
            except Exception:  # noqa: BLE001 - odd photos stay as they were
                continue


def _image_draw_scales(page) -> dict[str, float]:
    """Image name -> drawn width in points, from `cm .. /name Do` pairs.

    Only top-level content streams are read; photos inside Form XObjects
    stay unscaled (they are still recompressed).
    """
    scales: dict[str, float] = {}
    draws = re.compile(
        r"([0-9.-]+)\s+[0-9.-]+\s+[0-9.-]+\s+[0-9.-]+\s+[0-9.-]+\s+[0-9.-]+"
        r"\s+cm\s+(/\w+)\s+Do")
    chunks: list[bytes] = []
    try:
        contents = page.get_contents()
        streams = list(contents) if contents is not None and isinstance(
            contents, pypdf.generic.ArrayObject) else [contents]
        for stream in streams:
            if stream is not None and hasattr(stream, "get_data"):
                chunks.append(stream.get_data())
    except Exception:  # noqa: BLE001 - unreadable scales just mean no downscale
        return scales
    for width, name in draws.findall(b"".join(chunks).decode("latin-1", "ignore")):
        drawn = abs(float(width))
        if drawn > 0.01 and (name not in scales or drawn > scales[name]):
            scales[name] = drawn
    return scales


def _replace_image(writer, page, name, img_file, pil, drawn_pt: float | None):
    """Re-encode one image XObject as JPEG (quality 65, dpi-capped)."""
    from pypdf.generic import (DecodedStreamObject, NameObject, NumberObject)

    old = img_file.indirect_reference.get_object()
    filt = old.raw_get("/Filter") if hasattr(old, "raw_get") else None
    if filt is not None:
        # Only plain photos and plain bitmaps are rebuildable; JPX, CCITT
        # and JBIG2 images stay exactly as they were.
        try:
            filt = filt.get_object()
        except Exception:  # noqa: BLE001
            pass
        names = [filt] if isinstance(filt, str) else list(filt)
        for item in names:
            if str(item) not in ("/FlateDecode", "/DCTDecode"):
                return

    # JPEG can't carry alpha or CMYK safely through every viewer: normalise.
    if pil.mode not in ("RGB", "L"):
        pil = pil.convert("RGB")
    width, height = pil.size
    if width < 2 or height < 2:
        return

    # Downscale when the pixels outrun 150 dpi at the drawn size.
    if drawn_pt:
        ratio = (drawn_pt * TARGET_DPI / 72) / width
        if ratio < 0.999:
            new_size = (max(1, int(width * ratio)),
                        max(1, int(height * ratio)))
            pil = pil.resize(new_size, Image.LANCZOS)
            width, height = new_size

    buffer = io.BytesIO()
    pil.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    data = buffer.getvalue()
    try:
        stored = len(old._data) if hasattr(old, "_data") else 0
    except Exception:  # noqa: BLE001
        stored = 0
    if stored and len(data) >= stored:
        return  # the rebuild is not smaller: this photo stays as it was

    new_object = DecodedStreamObject()
    new_object.set_data(data)  # the JPEG bytes are the final /DCTDecode payload
    new_object[NameObject("/Type")] = NameObject("/XObject")
    new_object[NameObject("/Subtype")] = NameObject("/Image")
    new_object[NameObject("/Width")] = NumberObject(width)
    new_object[NameObject("/Height")] = NumberObject(height)
    new_object[NameObject("/BitsPerComponent")] = NumberObject(8)
    new_object[NameObject("/ColorSpace")] = NameObject(
        "/DeviceGray" if pil.mode == "L" else "/DeviceRGB")
    new_object[NameObject("/Filter")] = NameObject("/DCTDecode")
    if "/SMask" in old:  # keep the transparency mask
        new_object[NameObject("/SMask")] = old.raw_get("/SMask")
    new_object.indirect_reference = writer._add_object(new_object)
    xobjects = page["/Resources"].get("/XObject")
    if not xobjects:
        return
    xobjects[NameObject(name)] = new_object.indirect_reference


def lock_pdf(path: str, out_path: str, password: str) -> None:
    """Write an AES-256 password-protected copy. Password is not logged."""
    reader = _open(path)  # the damage test speaks before anything else
    if not password or not password.strip():
        raise ToolError("Type the same password twice to lock the copy.")
    writer = pypdf.PdfWriter()
    try:
        writer.append(reader)
        writer.encrypt(user_password=password, algorithm="AES-256")
        _write(writer, out_path)
    finally:
        # Best-effort: drop the shared reference right away. (Python keeps
        # the glyphs alive until the allocator runs; nothing is written to
        # disk, logs or responses.)
        password = None
        del password


def unlock_pdf(path: str, out_path: str, password: str | None = None) -> None:
    """Write a copy without any password. Locked-but-no-password raises
    with status 423 (the client then asks for it)."""
    try:
        reader = pypdf.PdfReader(path)
    except (pypdf.errors.PdfReadError, OSError, ValueError):
        raise ToolError("This PDF can't be read. It may be damaged.") from None

    if not reader.is_encrypted:
        raise ToolError(_NOT_LOCKED)
    if password is None:
        raise ToolError(_LOCKED_COPY, 423)

    unlocked = pypdf.PasswordType.NOT_DECRYPTED
    try:
        unlocked = reader.decrypt(password)
    except Exception:  # noqa: BLE001 - assorted pypdf errors count as wrong
        unlocked = pypdf.PasswordType.NOT_DECRYPTED
    password = None  # done with it: never logged, stored or echoed back
    if unlocked == pypdf.PasswordType.NOT_DECRYPTED:
        raise ToolError(_WRONG_PASSWORD)
    writer = pypdf.PdfWriter()
    writer.append(reader)
    _write(writer, out_path)


def extract_text(path: str) -> dict:
    """Pull the text out of every page. Scanned files come back empty."""
    reader = _open(path)
    total = len(reader.pages)
    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 - unreadable page reads as blank
            pages.append("")
    scanned = total > 0 and all(not text.strip() for text in pages)
    return {"total": total, "pages": pages, "scanned": scanned}



A4_PIXELS = (1240, 1754)  # A4 at 150 dpi
_IMAGE_FORMATS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def images_to_pdf(paths, out_path: str) -> int:
    """One PDF page per image, in the given order, fitted to A4.

    Reads EXIF orientation and never touches the source files.
    Returns the number of pages written.
    """
    if not paths:
        raise ToolError("No image files were sent. Choose images and try again.")
    pages = []
    for path in paths:
        try:
            image = Image.open(path)
        except (OSError, ValueError):
            raise ToolError("One of the images can't be read. It may be damaged.")
        image = ImageOps.exif_transpose(image) or image
        if image.mode != "RGB":
            image = image.convert("RGB")
        frame = image.copy()
        frame.thumbnail(A4_PIXELS, Image.LANCZOS)
        sheet = Image.new("RGB", A4_PIXELS, "#FFFFFF")
        sheet.paste(frame, ((A4_PIXELS[0] - frame.width) // 2,
                            (A4_PIXELS[1] - frame.height) // 2))
        pages.append(sheet)
    try:
        pages[0].save(out_path, save_all=True, append_images=pages[1:],
                      resolution=150, quality=88)
    except (OSError, ValueError):
        raise ToolError("The result file could not be written on this machine.", 500)
    return len(pages)
