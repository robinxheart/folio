"""PyMuPDF operations for Folio: watermark and text editing.

PyMuPDF sits beside pypdf because these two jobs need what pypdf does
not have: redactions (to truly remove text), shaped text writing
(MuPDF Story, for Unicode and non-Latin scripts) and fonts with wide
glyph coverage. Every failure raises ToolError with copy in the voice
from DESIGN.md, and every open speaks before it works: a damaged PDF
gets the shared "can't be read" line, a locked one gets the password
line shared with pdf_ops.

The original upload is never touched: server.py hands us a temp copy
and we only write to out_path.
"""

from __future__ import annotations

import io
import os
import re

import pymupdf
from PIL import Image

from pdf_ops import ToolError, _LOCKED_COPY, parse_pages

FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "fonts")

_DAMAGE_COPY = "This PDF can't be read. It may be damaged."
_SCAN_EDIT_COPY = "No editable text found. This PDF looks like a scan."
_PASSWORD_COPY = "That password didn't work. Try again."

_ARCHIVE = pymupdf.Archive(FONTS_DIR)  # font files for MuPDF Story (insert_htmlbox)

_SHRINK_NOTE = ("Some new text is longer than the old, so Folio made it "
                "smaller to fit the same box.")
_NOFIT_NOTE = "Some new text didn't fit its box and was left out."
_FALLBACK_NOTE = ("Some characters aren't in the chosen font, "
                  "so a fallback font drew them.")

# Font families the dropdowns offer. A variant source is ("base14", PDF
# base font name) or ("file", a file in static/fonts/). The DejaVu
# faces are bundled (see static/fonts/LICENSE_DEJAVU); the base-14 ones
# are standard PDF fonts.
FAMILIES = {
    "helvetica": ("Helvetica", {
        "r": ("base14", "helv"), "b": ("base14", "hebo"),
        "i": ("base14", "heit"), "bi": ("base14", "hebi"),
    }),
    "times": ("Times", {
        "r": ("base14", "tiro"), "b": ("base14", "tibo"),
        "i": ("base14", "tiit"), "bi": ("base14", "tibi"),
    }),
    "courier": ("Courier", {
        "r": ("base14", "cour"), "b": ("base14", "cobo"),
        "i": ("base14", "coit"), "bi": ("base14", "cobi"),
    }),
    "dejavusans": ("DejaVu Sans", {
        "r": ("file", "DejaVuSans.ttf"), "b": ("file", "DejaVuSans-Bold.ttf"),
        "i": ("file", "DejaVuSans-Oblique.ttf"),
        "bi": ("file", "DejaVuSans-BoldOblique.ttf"),
    }),
    "dejavuserif": ("DejaVu Serif", {
        "r": ("file", "DejaVuSerif.ttf"), "b": ("file", "DejaVuSerif-Bold.ttf"),
        "i": ("file", "DejaVuSerif-Italic.ttf"),
        "bi": ("file", "DejaVuSerif-BoldItalic.ttf"),
    }),
    "dejavumono": ("DejaVu Sans Mono", {
        "r": ("file", "DejaVuSansMono.ttf"), "b": ("file", "DejaVuSansMono-Bold.ttf"),
        "i": ("file", "DejaVuSansMono-Oblique.ttf"),
        "bi": ("file", "DejaVuSansMono-BoldOblique.ttf"),
    }),
}


def _open_doc(path: str, password: str | None = None) -> pymupdf.Document:
    """Open a PDF, speaking first about damage and locks."""
    try:
        doc = pymupdf.open(path)
    except Exception:  # noqa: BLE001 - MuPDF raises assorted types on bad input
        raise ToolError(_DAMAGE_COPY) from None
    if doc.needs_pass:
        if not password:
            raise ToolError(_LOCKED_COPY, 423)
        if not doc.authenticate(password):
            raise ToolError(_PASSWORD_COPY)
    return doc


def font_source(family: str, bold: bool, italic: bool) -> tuple[str, str]:
    """Resolve (family, bold, italic) to a variant source, falling back
    to the regular cut when a variant is missing."""
    entry = FAMILIES.get(family)
    if entry is None:
        raise ToolError("Choose a font from the list.")
    key = ("b" if bold else "") + ("i" if italic else "") or "r"
    sources = entry[1]
    return sources.get(key) or sources["r"]


def load_font(family: str, bold: bool, italic: bool) -> pymupdf.Font:
    kind, value = font_source(family, bold, italic)
    if kind == "file":
        return pymupdf.Font(fontfile=os.path.join(FONTS_DIR, value))
    return pymupdf.Font(value)


def _hex_to_rgb(value: str) -> tuple[float, float, float]:
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or "").strip())
    if not match:
        raise ToolError("Pick the colour with the colour picker.")
    h = match.group(1)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _int_color_to_hex(value: int) -> str:
    return "#{:06x}".format(int(value) & 0xFFFFFF)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _covered(font: pymupdf.Font, text: str) -> bool:
    """True when the font has a glyph for every visible character."""
    return all(ch in "\n\t" or not ch.strip() or font.has_glyph(ord(ch))
               for ch in text)


# --------------------------------------------------------------------------
# watermark
# --------------------------------------------------------------------------

def watermark(path: str, out_path: str, *, text: str = "", image_path: str | None = None,
              family: str = "helvetica", bold: bool = False, italic: bool = False,
              size: float = 48, colour: str = "#9aa0a6", opacity: float = 0.2,
              angle: float = 45, position: str = "centre", margin: float = 36,
              scale: float = 0.3, pages: str = "", behind: bool = False,
              password: str | None = None, notes: list[str] | None = None) -> int:
    """Stamp a text or image watermark on the chosen pages.

    Returns the number of pages that got the stamp. Arbitrary angles
    come from a rotation matrix (morph) because plain rotate only does
    90s; transparency rides on fill_opacity / stroke_opacity.
    """
    text = str(text or "").strip()
    if not text and not image_path:
        raise ToolError("Type the watermark text or choose an image first.")
    if text and image_path:
        raise ToolError("Use either text or an image, not both.")

    size = _clamp(float(size), 4, 288)
    opacity = _clamp(float(opacity), 0.01, 1)
    angle = float(angle) % 360
    margin = _clamp(float(margin), 0, 300)
    scale = _clamp(float(scale), 0.02, 1)
    rgb = _hex_to_rgb(colour)
    position = position if position in ("centre", "tiled", "corners") else "centre"

    doc = _open_doc(path, password)
    try:
        indices = parse_pages(pages, doc.page_count) or list(range(doc.page_count))
        for pno in indices:
            if pno < 0 or pno >= doc.page_count:
                raise ToolError(f"Page {pno + 1} is not in this PDF.")
            page = doc[pno]
            if image_path:
                _stamp_image(page, image_path, opacity, angle, position,
                             margin, scale, behind)
            else:
                _stamp_text(page, text, family, bold, italic, size, rgb,
                            opacity, angle, position, margin, behind, notes)
        doc.save(out_path, garbage=4, deflate=True)
    finally:
        doc.close()
    return len(indices)


def _stamp_text(page: pymupdf.Page, text: str, family: str, bold: bool, italic: bool,
                size: float, rgb, opacity: float, angle: float, position: str,
                margin: float, behind: bool, notes: list[str] | None) -> None:
    font = load_font(family, bold, italic)
    # A character the chosen family lacks (CJK, say) falls back to the
    # built-in wide font, so the stamp never draws tofu boxes.
    if not _covered(font, text):
        font = pymupdf.Font("cjk")
        if notes is not None:
            notes.append(_FALLBACK_NOTE)
    width = font.text_length(text, fontsize=size)
    height = size * 1.2
    rect = page.rect
    m = min(margin, rect.width / 4, rect.height / 4)

    if position == "centre":
        spots = [((rect.width - width) / 2, (rect.height - height) / 2)]
    elif position == "corners":
        spots = [(m, m), (rect.width - m - width, m),
                 (m, rect.height - m - height),
                 (rect.width - m - width, rect.height - m - height)]
    else:  # tiled grid
        step_x = max(width + 2 * m, width + 12)
        step_y = max(height * 3, height + m + 12)
        spots = [(x, y) for y in range(int(m), max(int(rect.height - height), int(m) + 1),
                                       int(step_y))
                 for x in range(int(m), max(int(rect.width - width), int(m) + 1),
                                int(step_x))]
        if not spots:
            spots = [(m, m)]

    for x, y in spots:
        tw = pymupdf.TextWriter(page.rect)
        tw.fill_opacity = opacity
        tw.stroke_opacity = opacity
        tw.append(pymupdf.Point(x, y), text, font=font, fontsize=size)
        # The morph matrix rotates around the stamp's own centre, so the
        # pivot keeps every angle where it was placed.
        pivot = pymupdf.Point(x + width / 2, y + height / 2)
        tw.write_text(page, color=rgb, morph=(pivot, pymupdf.Matrix(angle)),
                      overlay=not behind)


def _stamp_image(page: pymupdf.Page, image_path: str, opacity: float, angle: float,
                 position: str, margin: float, scale: float, behind: bool) -> None:
    img = Image.open(image_path)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    if opacity < 0.999:
        # Keep the file's own transparency and multiply the opacity in.
        img.putalpha(img.getchannel("A").point(lambda v: round(v * opacity)))
    if angle % 360:
        # PIL rotates counter-clockwise; the on-screen result must match
        # the CSS overlay preview (clockwise), so the sign flips here.
        img = img.rotate(-angle, expand=True, resample=Image.Resampling.BICUBIC)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()

    rect = page.rect
    m = min(margin, rect.width / 4, rect.height / 4)
    base = min(rect.width, rect.height) * scale
    w = base
    h = base * img.size[1] / img.size[0]
    if position == "centre":
        rects = [pymupdf.Rect((rect.width - w) / 2, (rect.height - h) / 2,
                              (rect.width + w) / 2, (rect.height + h) / 2)]
    elif position == "corners":
        rects = []
        for cx, cy in ((m, m), (rect.width - m - w, m),
                       (m, rect.height - m - h),
                       (rect.width - m - w, rect.height - m - h)):
            rects.append(pymupdf.Rect(cx, cy, cx + w, cy + h))
    else:  # tiled grid
        step_x = max(w + 2 * m, w + 12)
        step_y = max(h + 2 * m, h + 12)
        rects = [pymupdf.Rect(x, y, x + w, y + h)
                 for y in range(int(m), max(int(rect.height - h), int(m) + 1), int(step_y))
                 for x in range(int(m), max(int(rect.width - w), int(m) + 1), int(step_x))]
        if not rects:
            rects = [pymupdf.Rect(m, m, m + w, m + h)]
    for r in rects:
        page.insert_image(r, stream=data, overlay=not behind)


# --------------------------------------------------------------------------
# text editing: span listing
# --------------------------------------------------------------------------

def _match_font(name: str, flags: int) -> dict:
    """Match an embedded or standard font name to what Folio offers.

    Subset prefixes ("ABCDEF+Calibri") are stripped. A family Folio
    carries is reused as-is; anything else falls back to the closest
    base family by the span's own serif/mono hints and is marked
    substituted so the panel can say so.
    """
    clean = str(name).split("+")[-1].strip()
    low = re.sub(r"[\s\-_]", "", clean.lower())
    bold = bool(flags & 16) or "bold" in low
    italic = bool(flags & 2) or "italic" in low or "oblique" in low

    if "dejavu" in low:
        if "mono" in low:
            family = "dejavumono"
        elif "serif" in low:
            family = "dejavuserif"
        else:
            family = "dejavusans"
        return {"family": family, "bold": bold, "italic": italic, "substituted": False}
    if "helvetica" in low or "arial" in low or "nimbussans" in low \
            or "univers" in low or "liberationsans" in low:
        return {"family": "helvetica", "bold": bold, "italic": italic, "substituted": False}
    if "times" in low or "nimbusroman" in low or "timesnewroman" in low \
            or "georgia" in low or "garamond" in low or "liberationserif" in low:
        return {"family": "times", "bold": bold, "italic": italic, "substituted": False}
    if "courier" in low or "nimbusmono" in low or "couriernew" in low \
            or "consolas" in low or "liberationmono" in low:
        return {"family": "courier", "bold": bold, "italic": italic, "substituted": False}

    # Not a face Folio carries: pick the closest base family.
    if flags & 8:
        return {"family": "courier", "bold": bold, "italic": italic, "substituted": True}
    if flags & 4:
        return {"family": "times", "bold": bold, "italic": italic, "substituted": True}
    return {"family": "helvetica", "bold": bold, "italic": italic, "substituted": True}


def spans(path: str, password: str | None = None) -> dict:
    """Text spans per page for the Edit tab, from page.get_text("dict")."""
    doc = _open_doc(path, password)
    try:
        pages = []
        total_spans = 0
        fonts: dict[str, dict] = {}
        for pno, page in enumerate(doc):
            raw = page.get_text("dict")
            page_spans = []
            page_rotated = False
            for block in raw.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    dx, dy = line.get("dir", (1, 0))
                    line_rotated = abs(dx - 1) > 0.01 or abs(dy) > 0.01
                    page_rotated = page_rotated or line_rotated
                    for s in line.get("spans", []):
                        body = s.get("text", "")
                        if not body.strip():
                            continue
                        bbox = [round(v, 1) for v in s["bbox"]]
                        if bbox[2] - bbox[0] <= 0 or bbox[3] - bbox[1] <= 0:
                            continue
                        if s["font"] not in fonts:
                            fonts[s["font"]] = _match_font(s["font"], s["flags"])
                        page_spans.append({
                            "id": len(page_spans),
                            "text": body,
                            "bbox": bbox,
                            "font": s["font"],
                            "size": round(s["size"], 1),
                            "colour": _int_color_to_hex(s["color"]),
                            "flags": int(s["flags"]),
                            "rotated": line_rotated,
                        })
            total_spans += len(page_spans)
            pages.append({
                "n": pno + 1,
                "width": round(page.rect.width, 1),
                "height": round(page.rect.height, 1),
                "rotation": page.rotation,
                "rotated": page_rotated,
                "spans": page_spans,
            })
        if total_spans == 0:
            raise ToolError(_SCAN_EDIT_COPY)
        return {
            "total": doc.page_count,
            "pages": pages,
            "fonts": fonts,
            "families": {fid: label for fid, (label, _) in FAMILIES.items()},
        }
    finally:
        doc.close()


# --------------------------------------------------------------------------
# text editing: apply
# --------------------------------------------------------------------------

def _validate_edit(e, page_count: int) -> dict:
    if not isinstance(e, dict):
        raise ToolError("Something went wrong with the edit list. Try again.")
    kind = e.get("kind")
    if kind not in ("change", "delete", "add"):
        raise ToolError("Something went wrong with the edit list. Try again.")
    try:
        page = int(e.get("page"))
        bbox = [float(v) for v in e.get("bbox")]
        size = float(e.get("size"))
    except (TypeError, ValueError):
        raise ToolError("Something went wrong with the edit list. Try again.") from None
    if not 0 <= page < page_count:
        raise ToolError(f"Page {page + 1} is not in this PDF.")
    if len(bbox) != 4 or bbox[2] - bbox[0] <= 0 or bbox[3] - bbox[1] <= 0:
        raise ToolError("Something went wrong with the edit list. Try again.")
    text = str(e.get("text") or "")
    if kind != "delete" and not text.strip():
        raise ToolError("Type the new text before saving.")
    return {
        "kind": kind, "page": page,
        "bbox": pymupdf.Rect(bbox), "text": text,
        "family": str(e.get("family") or "helvetica"),
        "bold": bool(e.get("bold")), "italic": bool(e.get("italic")),
        "size": _clamp(size, 1, 288),
        "colour": str(e.get("colour") or "#000000"),
    }


def apply_edits(path: str, out_path: str, edits: list, notes: list[str],
                password: str | None = None) -> int:
    """Apply queued edits: redact the old boxes (text only), write the
    new text, save. Returns the number of pages touched."""
    if not isinstance(edits, list):
        raise ToolError("Something went wrong with the edit list. Try again.")
    doc = _open_doc(path, password)
    try:
        by_page: dict[int, list[dict]] = {}
        for e in edits:
            e = _validate_edit(e, doc.page_count)
            by_page.setdefault(e["page"], []).append(e)
        if not by_page:
            raise ToolError("Queue an edit before saving.")

        for pno in sorted(by_page):
            page = doc[pno]
            # Sample the background colour and queue the redactions
            # while the page is still the original.
            for e in by_page[pno]:
                if e["kind"] == "add":
                    continue
                bg = _sample_background(page, e["bbox"])
                page.add_redact_annot(e["bbox"] + (-0.5, -0.5, 0.5, 0.5), fill=bg)
            if any(e["kind"] != "add" for e in by_page[pno]):
                # images and graphics stay untouched; only the text goes.
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                                      graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                      text=pymupdf.PDF_REDACT_TEXT_REMOVE)
            for e in by_page[pno]:
                if e["kind"] != "delete":
                    _write_text(page, e["bbox"], e, notes)
        notes[:] = list(dict.fromkeys(notes))
        doc.save(out_path, garbage=4, deflate=True)
    finally:
        doc.close()
    return len(by_page)


def _sample_background(page: pymupdf.Page, rect: pymupdf.Rect) -> tuple[float, float, float]:
    """Most common colour in a thin ring just outside the text box.

    The ring (not the box itself) is sampled so the glyphs don't skew
    the answer. White is the fallback.
    """
    clip = pymupdf.Rect(rect) + (-6, -6, 6, 6)
    clip &= page.rect
    if clip.is_empty or clip.width <= 1 or clip.height <= 1:
        return (1, 1, 1)
    pix = page.get_pixmap(clip=clip, matrix=pymupdf.Matrix(2, 2),
                          colorspace=pymupdf.csRGB, alpha=False)
    w, h = pix.width, pix.height
    counts: dict[tuple[int, int, int], int] = {}
    samples = pix.samples
    stride = pix.stride or w * 3

    def take(x: int, y: int) -> None:
        off = y * stride + x * 3
        key = (samples[off], samples[off + 1], samples[off + 2])
        counts[key] = counts.get(key, 0) + 1

    for x in range(w):
        take(x, 0)
        take(x, h - 1)
    for y in range(h):
        take(0, y)
        take(w - 1, y)
    if not counts:
        return (1, 1, 1)
    r, g, b = max(counts, key=counts.get)  # type: ignore[arg-type]
    return (r / 255, g / 255, b / 255)


def _write_text(page: pymupdf.Page, box: pymupdf.Rect, e: dict, notes: list[str]) -> None:
    """Write one edit's text at the original position.

    insert_htmlbox (MuPDF Story) is preferred so Unicode and non-Latin
    scripts shape correctly; insert_textbox is the fallback. Overflow
    wraps inside the box; if the text then still doesn't fit it is
    shrunk and the user is told.
    """
    family, bold, italic = e["family"], e["bold"], e["italic"]
    size = e["size"]
    rgb = _hex_to_rgb(e["colour"])
    target = pymupdf.Rect(box) + (-1, -1, 1, max(2, size * 0.2))
    target &= page.rect
    if target.is_empty:
        notes.append(f"One edit on page {page.number + 1} sits outside the page, "
                     "so Folio left it out.")
        return

    kind, value = font_source(family, bold, italic)
    font = load_font(family, bold, italic)

    if kind == "base14" and _covered(font, e["text"]):
        # Exact base-14 face: plain insert_textbox keeps it that way.
        _write_textbox(page, target, e["text"], value, size, rgb, notes)
        return

    # Story path: the family's own file, DejaVu for base-14 faces that
    # can't draw the text, or the built-in fallback for the rest.
    css_name, face = _story_face(family, bold, italic, e["text"])
    if face is None:
        notes.append(_FALLBACK_NOTE)
    css = None
    if face:
        css = f'@font-face {{font-family: foliofont; src: url("{face}");}}'
    body = (f'<div style="font-family: {css_name}; font-size: {size}px; '
            f'color: {e["colour"]}; line-height: 1.15; margin: 0;">'
            f'{_escape_html(e["text"])}</div>')
    _spare, scale_used = page.insert_htmlbox(target, body, css=css, archive=_ARCHIVE)
    if scale_used < 0.75:
        notes.append(_SHRINK_NOTE)


def _story_face(family: str, bold: bool, italic: bool, text: str) -> tuple[str, str | None]:
    """Pick a font for MuPDF Story: returns (CSS font-family value, the
    file to declare via @font-face, or None for the built-in fallback)."""
    kind, value = font_source(family, bold, italic)
    if kind == "file":
        if _covered(pymupdf.Font(fontfile=os.path.join(FONTS_DIR, value)), text):
            return "foliofont", value
        return "sans-serif", None  # built-in fallback (incl. CJK)
    if _covered(pymupdf.Font(fontfile=os.path.join(FONTS_DIR, "DejaVuSans.ttf")), text):
        return "foliofont", "DejaVuSans.ttf"
    return "sans-serif", None


def _escape_html(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;"))


def _write_textbox(page: pymupdf.Page, rect: pymupdf.Rect, text: str,
                   fontname: str, size: float, rgb, notes: list[str]) -> bool:
    """insert_textbox fallback: shrink in 10% steps if the text does not
    fit its box. Returns True when the text landed."""
    current = size
    while True:
        spare = page.insert_textbox(rect, text, fontname=fontname, fontsize=current,
                                    color=rgb)
        if spare >= 0:
            if current < size * 0.75 - 1e-9:
                notes.append(_SHRINK_NOTE)
            return True
        current *= 0.9
        if current < 4:
            notes.append(_NOFIT_NOTE)
            return False
