"""Generate sample material for Folio's phase 4 tests (compress, lock,
unlock, text). Local test material only.

- big200.pdf: 200 pages of real text with UNCOMPRESSED content streams,
  so Standard compress shows a real, lossless saving and Text has a
  200-page case.
- photos-heavy.pdf: giant embedded JPEGs drawn far smaller than they
  need to be, so Strong compress earns its keep (and Standard shows the
  little-gain copy).
- scanned.pdf: pages that are only photographs of writing - no text
  layer at all - for the Text tool's scan message.
- corrupt.pdf: PDF-shaped bytes that no reader can open.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 992, 1403   # A4 proportions at ~120 dpi
DPI = 120
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")

WORDS = ("the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
         "while", "students", "write", "assignments", "quiet", "library",
         "every", "margin", "before", "deadline", "morning", "review")


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def write_big200() -> None:
    """200 pages of hand-written text, streams left raw (no flate)."""
    import pypdf
    from pypdf.generic import (DecodedStreamObject, DictionaryObject,
                               NameObject)

    writer = pypdf.PdfWriter()
    font_dict = DictionaryObject()
    font_dict[NameObject("/Type")] = NameObject("/Font")
    font_dict[NameObject("/Subtype")] = NameObject("/Type1")
    font_dict[NameObject("/BaseFont")] = NameObject("/Helvetica")
    font_ref = writer._add_object(font_dict)

    for number in range(1, 201):
        page = pypdf._page.PageObject.create_blank_page(width=612, height=792)
        lines = [f"Big 200 sample - page {number} of 200"]
        for row in range(44):
            words = [WORDS[(row * 9 + i * 3 + number) % len(WORDS)]
                     for i in range(11)]
            lines.append(" ".join(words))
        ops = ["BT", "/F1 11 Tf", "72 730 Td", "13 TL"]
        for line in lines:
            ops.append(f"({line.replace('(', '[').replace(')', ']')}) Tj T*")
        ops.append("ET")
        stream = DecodedStreamObject()
        stream.set_data("\n".join(ops).encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        resources = DictionaryObject()
        fonts = DictionaryObject()
        fonts[NameObject("/F1")] = font_ref
        resources[NameObject("/Font")] = fonts
        page[NameObject("/Resources")] = resources
        writer.add_page(page)

    writer.add_metadata({"/Title": "Big 200 sample",
                         "/Author": "S. Student"})
    path = os.path.join(SAMPLES, "big200.pdf")
    with open(path, "wb") as fh:
        writer.write(fh)
    print(f"wrote big200.pdf: {os.path.getsize(path)} bytes, uncompressed streams")


def write_photos_heavy() -> None:
    """Two pages, each one oversized photo drawn far smaller than it needs
    (2400 px wide but drawn at 468 pt) so Strong rebuilds it smaller."""
    import io

    import pypdf
    from pypdf.generic import (DecodedStreamObject, DictionaryObject,
                               NameObject, NumberObject)

    writer = pypdf.PdfWriter()
    titles = ["Photos IO notes, sheet 1", "Photos IO notes, sheet 2"]
    captions = [
        ["Photograph of the week 7 problem set, kept full size here.",
         "The sheet is drawn at A4; the pixels behind it are far wider.",
         "Strong compression may rebuild it smaller."],
        ["Second photograph, same story: more pixels than the page needs.",
         "Everything stays one page long when it is rebuilt."],
    ]
    for i, title in enumerate(titles):
        photo = Image.new("RGB", (2400, 3200), "#FFFFFF")
        draw = ImageDraw.Draw(photo)
        draw.text((120, 120), title, fill="#1F2A44", font=font(64))
        y = 240
        for line in captions[i]:
            draw.text((120, y), line, fill="#2A3345", font=font(40))
            y += 64
        for row in range(520):
            words = [WORDS[(row + i * 5 + j) % len(WORDS)] for j in range(9)]
            draw.text((120, 900 + row * 34), " ".join(words),
                      fill="#324055", font=font(24))
        buf = io.BytesIO()
        photo.save(buf, format="JPEG", quality=88, optimize=True)

        page = pypdf._page.PageObject.create_blank_page(width=612, height=792)
        xobj = DecodedStreamObject()
        xobj.set_data(buf.getvalue())
        xobj[NameObject("/Type")] = NameObject("/XObject")
        xobj[NameObject("/Subtype")] = NameObject("/Image")
        xobj[NameObject("/Width")] = NumberObject(2400)
        xobj[NameObject("/Height")] = NumberObject(3200)
        xobj[NameObject("/BitsPerComponent")] = NumberObject(8)
        xobj[NameObject("/ColorSpace")] = NameObject("/DeviceRGB")
        xobj[NameObject("/Filter")] = NameObject("/DCTDecode")
        photo_ref = writer._add_object(xobj)

        content = DecodedStreamObject()
        content.set_data(b"q 468 0 0 648 72 72 cm /Photo0 Do Q")
        page[NameObject("/Contents")] = writer._add_object(content)
        resources = DictionaryObject()
        xobjects = DictionaryObject()
        xobjects[NameObject("/Photo0")] = photo_ref
        resources[NameObject("/XObject")] = xobjects
        page[NameObject("/Resources")] = resources
        writer.add_page(page)

    writer.add_metadata({"/Title": "Photos heavy sample"})
    path = os.path.join(SAMPLES, "photos-heavy.pdf")
    with open(path, "wb") as fh:
        writer.write(fh)
    print(f"wrote photos-heavy.pdf: {os.path.getsize(path)} bytes")


def write_scanned() -> None:
    """Pages with NO text layer: the words exist only as pixels."""
    pages = [
        ("Scanned notes - page 1",
         ["These notes arrived as a photograph.",
          "The words live in the pixels only.",
          "There is no text layer under this page.",
          "Copy tools will find nothing here.",
          "That is the whole point of this sample."]),
        ("Scanned notes - page 2",
         ["Week 8 statistics, photographed in a rush.",
          "Variance sits at the top right.",
          "The professor circles the result twice.",
          "No OCR runs in this phase, so the",
          "Text tool reports a scan and stops."]),
        ("Scanned notes - page 3",
         ["Lab record page, stapled and scanned.",
          "Weight A swings 198 times per minute.",
          "Weight B swings 224 times per minute.",
          "Difference recorded as 26.",
          "Nothing here is selectable text."]),
    ]
    images = []
    for title, lines in pages:
        img = Image.new("RGB", (W, H), "#FFFFFF")
        draw = ImageDraw.Draw(img)
        draw.rectangle((0, 0, W, 132), fill="#5A5F6B")
        draw.text((72, 44), title, fill="#FFFFFF", font=font(40))
        y = 220
        for line in lines:
            draw.text((72, y), line, fill="#262B33", font=font(28))
            y += 48
        draw.line((72, H - 130, W - 72, H - 130), fill="#C9CEDA", width=2)
        draw.text((W - 340, H - 100), "scan quality: pocket handheld",
                  fill="#5A6272", font=font(20))
        images.append(img)
    path = os.path.join(SAMPLES, "scanned.pdf")
    images[0].save(path, save_all=True, append_images=images[1:], resolution=DPI)
    print(f"wrote scanned.pdf: {os.path.getsize(path)} bytes (no text layer)")


def write_corrupt() -> None:
    path = os.path.join(SAMPLES, "corrupt.pdf")
    with open(path, "wb") as fh:
        fh.write(b"%PDF-1.4\n")
        fh.write(b"this header promises a pdf, the body does not keep it\n")
        fh.write(os.urandom(2048))
    print(f"wrote corrupt.pdf: {os.path.getsize(path)} bytes")


def write_text20() -> None:
    """20 pages of real text (fast strip rendering for UI demos)."""
    import pypdf
    from pypdf.generic import (DecodedStreamObject, DictionaryObject,
                               NameObject)

    writer = pypdf.PdfWriter()
    font_dict = DictionaryObject()
    font_dict[NameObject("/Type")] = NameObject("/Font")
    font_dict[NameObject("/Subtype")] = NameObject("/Type1")
    font_dict[NameObject("/BaseFont")] = NameObject("/Helvetica")
    font_ref = writer._add_object(font_dict)

    for number in range(1, 21):
        page = pypdf._page.PageObject.create_blank_page(width=612, height=792)
        lines = [f"Static notes - sheet {number} of 20"]
        for row in range(30):
            words = [WORDS[(row * 9 + i * 3 + number) % len(WORDS)]
                     for i in range(11)]
            lines.append(" ".join(words))
        ops = ["BT", "/F1 11 Tf", "72 730 Td", "13 TL"]
        for line in lines:
            ops.append(f"({line.replace('(', '[').replace(')', ']')}) Tj T*")
        ops.append("ET")
        stream = DecodedStreamObject()
        stream.set_data("\n".join(ops).encode("latin-1"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        resources = DictionaryObject()
        fonts = DictionaryObject()
        fonts[NameObject("/F1")] = font_ref
        resources[NameObject("/Font")] = fonts
        page[NameObject("/Resources")] = resources
        writer.add_page(page)

    writer.add_metadata({"/Title": "Static notes sample",
                         "/Author": "S. Student"})
    path = os.path.join(SAMPLES, "text20.pdf")
    with open(path, "wb") as fh:
        writer.write(fh)
    print(f"wrote text20.pdf: {os.path.getsize(path)} bytes")


def main() -> None:
    os.makedirs(SAMPLES, exist_ok=True)
    write_text20()
    write_big200()
    write_photos_heavy()
    write_scanned()
    write_corrupt()


if __name__ == "__main__":
    main()
