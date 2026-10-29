"""Generate sample PDFs for testing Folio (Merge + Info). Local test material only."""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter

W, H = 992, 1403  # A4 proportions at ~120 dpi
DPI = 120
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def page(title, subtitle, paragraphs, page_n, total, band):
    img = Image.new("RGB", (W, H), "#FFFFFF")
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, W, 148), fill=band)
    draw.text((72, 44), title, fill="#FFFFFF", font=font(44))
    draw.text((72, 96), subtitle, fill="#D9DEE8", font=font(24))

    y = 208
    for para in paragraphs:
        for line in para:
            draw.text((72, y), line, fill="#262B33", font=font(26))
            y += 40
        y += 20
        if y > H - 160:
            draw.text((72, y), "(", fill="#FFFFFF", font=font(26))  # safety, keeps inside
            break
    draw.line((72, H - 120, W - 72, H - 120), fill="#C9CEDA", width=2)
    label = f"Page {page_n} of {total}"
    tw = draw.textlength(label, font=font(22))
    draw.text((W - 72 - tw, H - 92), label, fill="#5A6272", font=font(22))
    return img


def build(name, band, pages, title, subtitles):
    images = []
    for i, paras in enumerate(pages, start=1):
        subtitle = subtitles[i - 1] if i - 1 < len(subtitles) else ""
        images.append(page(title, subtitle, paras, i, len(pages), band))
    images[0].save(os.path.join(SAMPLES, name), save_all=True,
                   append_images=images[1:], resolution=DPI)
    print(f"wrote {name}: {len(images)} pages")


def para_lines(text, width=84):
    words = text.split()
    lines, line = [], ""
    for word in words:
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    lines.append(line)
    return lines


def main():
    os.makedirs(SAMPLES, exist_ok=True)

    assignment = [
        """Let A be a 4 by 4 matrix with entries in the set of real numbers such that
the determinant of A equals minus three. Show that the columns of A are linearly
independent and describe the null space of the transpose of A.""",
        """Q2. Consider the linear map T from R4 to R2 given by T of x equals the pair
(M x, x1 plus x2). Compute the rank of T, find a basis for its kernel, and state
the dimension theorem for this case.""",
        """Q3. A matrix P is called a projection if P squared equals P itself. Prove
that every projection is diagonalisable, that its eigenvalues are zero or one,
and that the trace of P equals the rank of P. Give one counterexample for the
reverse direction.""",
        """Work on your own and hand in the sheets printed at the back of this brief.
Late submissions drop one letter grade per day. Keep margins at least a thumb
wide so the printed feedback fits alongside your working.""",
    ]
    lab = [
        """X1. Set up the cart on the air track with the photogate at mark A, twenty
centimetres from the release point. Release the cart from rest three times and
record the passage times for each run in the table on the following page.""",
        """X2. For the inclined run, raise the far end of the track by one coarse block
and repeat the timing plan. Compare the three measured speeds against the model
prediction for a frictionless incline and note where they diverge.""",
    ]
    notes = [
        """Statics notes, week 5. A frame is statically determinate when every internal
force follows from equilibrium alone. Count members and joints twice before you
believe a frame; the quick check is m plus three equals two j for plane frames.""",
    ]

    build("assignment.pdf", "#24344D",
          [[para_lines(t) for t in assignment],
           [para_lines(t) for t in assignment[:3]],
           [para_lines(t) for t in assignment[1:4]]],
          "Linear Algebra — Assignment 1",
          ["Problems, context and submission notes", "Selected problems", "Worked notes"])

    build("lab-record.pdf", "#3D4A66",
          [[para_lines(t) for t in lab],
           [para_lines("The timing table below holds the three inclined runs. Fill every row "
                       "with the photogate time, speed, and the residual against the model.")]],
          "Physics lab record — Experiment 4",
          ["Timing runs on the air track", "Incline runs"])

    build("notes.pdf", "#6A7488",
          [[para_lines(t) for t in notes]],
          "Statics notes — week 5",
          ["Frames, trusses and determinacy"])

    build("notes-2.pdf", "#55607A",
          [[para_lines("Revision sheet. Statically indeterminate frames need the force method. "
                       "Write the compatibility equations before the equilibrium equations; "
                       "the order saves a page of corrections.")]],
          "Statics revision sheet",
          ["Force method in four lines"])

    # Sample images for the Images-to-PDF tool (Phase 2), incl. one JPEG
    # with EXIF orientation so the EXIF path gets exercised.
    def make_image(name, size, band, title, lines, orientation=None):
        img = _frame(size, band, title, lines)
        exif = None
        if orientation:
            # Simulate a phone that stores the frame sideways and tags it
            # ("rotate 90 deg CW to display"). Storing must transpose the
            # upright frame, so display apps - and the server's
            # exif_transpose - put the content back upright.
            img = img.transpose(Image.Transpose.ROTATE_90)
            exif = img.getexif()
            exif[274] = orientation
        args = {"quality": 88}
        if exif is not None:
            args["exif"] = exif.tobytes()
        img.save(os.path.join(SAMPLES, name), **args)
        print(f"wrote {name}: {img.size[0]}x{img.size[1]}")

    def _frame(size, band, title, lines):
        img = Image.new("RGB", size, "#FFFFFF")
        draw = ImageDraw.Draw(img)
        header = min(120, size[1] // 6)
        draw.rectangle((0, 0, size[0], header), fill=band)
        draw.text((32, header // 3), title, fill="#FFFFFF", font=font(28))
        y = header + 24
        for line in lines:
            draw.text((32, y), line, fill="#262B33", font=font(22))
            y += 34
        return img

    make_image("notes-photo.jpg", (992, 1403), "#35507B", "Photo of week 6 notes",
               ["Shear and bending diagrams for beam A."])
    make_image("board-photo.jpg", (1403, 992), "#2E5446", "Whiteboard - lab setup",
               ["Track level, both photogates open."], orientation=6)
    make_image("slide-photo.jpg", (800, 600), "#6A7488", "Slide 4 - results",
               ["Run times within 3% of model."])

    # A password-protected sample (password: notes) for error-path testing.
    src = os.path.join(SAMPLES, "notes.pdf")
    reader = PdfReader(src)
    writer = PdfWriter()
    for page_obj in reader.pages:
        writer.add_page(page_obj)
    writer.add_metadata({"/Title": "Locked week 5 notes", "/Author": "S._student"})
    writer.encrypt("notes")
    with open(os.path.join(SAMPLES, "locked.pdf"), "wb") as fh:
        writer.write(fh)
    print("wrote locked.pdf: password 'notes'")

    # A non-PDF file with a PDF-ish name is made by writing plain bytes.
    with open(os.path.join(SAMPLES, "ray-notes.txt"), "wb") as fh:
        fh.write(b"this is text, not a pdf\n" * 40)
    print("wrote ray-notes.txt (wrong-type test)")


if __name__ == "__main__":
    main()
