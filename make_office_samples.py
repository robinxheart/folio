"""Generate the Phase 3 conversion samples with Microsoft Office COM.

Creates (in samples/):
    report.docx      Word report with an embedded photo and a table
    wide-table.xlsx  Excel sheet with a deliberately wide table
    deck.pptx        a three-slide PowerPoint
    locked.docx      the Word report, password-protected ("notes")
    corrupt.docx     garbage bytes that are not a real .docx
    notes.md         markdown (no pandoc here; tests the Word-as-plain-text path)
    hello.txt        plain text source for a quick Word conversion

Run:  python make_office_samples.py
"""

from __future__ import annotations

import os

import pythoncom
import win32com.client

ROOT = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(ROOT, "samples")
PHOTO = os.path.join(SAMPLES, "board-photo.jpg")


def make_report(path: str, password: str | None = None) -> None:
    """A real Word document: heading, photo, table - the spec test file."""
    pythoncom.CoInitialize()
    word = win32com.client.DispatchEx("Word.Application")
    try:
        word.Visible = False
        doc = word.Documents.Add()
        rng = doc.Range(0, 0)
        rng.Style = doc.Styles("Title")
        rng.Text = "Lab report"
        para = doc.Paragraphs.Add()
        para.Range.InsertAfter(
            "\rA short report with an image and a table, made for testing "
            "the Convert to PDF tool of Folio.")
        doc.InlineShapes.AddPicture(PHOTO, Range=doc.Paragraphs(3).Range)
        para = doc.Paragraphs.Add()
        para.Range.InsertParagraphAfter()
        rng = para.Range
        rng.InsertAfter("Measurements\r")
        table = doc.Tables.Add(doc.Paragraphs(doc.Paragraphs.Count).Range,
                               4, 3)
        rows = [["Day", "Reading", "Note"],
                ["1", "12.0", "start"],
                ["2", "12.7", "warmed up"],
                ["3", "13.1", "steady"]]
        for r, row in enumerate(rows, start=1):
            for c, value in enumerate(row, start=1):
                table.Cell(r, c).Range.Text = value
        if password:
            # SaveAs2's Password kwarg is unreliable through dynamic
            # dispatch; the Document.Password property writes it for sure.
            doc.Password = password
            doc.SaveAs2(path, FileFormat=12)
            doc.Password = ""
        else:
            doc.SaveAs2(path, FileFormat=12)
    finally:
        word.Quit(SaveChanges=0)
        pythoncom.CoUninitialize()


def make_wide_sheet(path: str) -> None:
    """A wide table, so the fit-one-page-wide page setup has a job."""
    pythoncom.CoInitialize()
    excel = win32com.client.DispatchEx("Excel.Application")
    try:
        excel.Visible = False
        excel.DisplayAlerts = False
        sheet_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        sheet_nums = list(range(101, 113))
        wb = excel.Workbooks.Add()
        ws = wb.Worksheets(1)
        ws.Name = "Results"
        ws.Cells(1, 1).Value = "Student"
        for col, name in enumerate(sheet_names, start=2):
            ws.Cells(1, col).Value = name
        ws.Cells(2, 1).Value = "V. Rao"
        for col, num in enumerate(sheet_nums, start=2):
            ws.Cells(2, col).Value = num
        ws.Cells(3, 1).Value = "S. Iyer"
        ws.Cells(3, 2).Value = "99"
        for col in range(3, len(sheet_nums) + 2):
            ws.Cells(3, col).Value = col + 20
        ws.Cells(4, 1).Value = "A. Khan"
        for col in range(2, len(sheet_nums) + 2):
            ws.Cells(4, col).Value = 60 + col
        widths = ws.Range("A:L").Columns
        widths.AutoFit()
        wb.SaveAs(path, FileFormat=51)  # xlOpenXMLWorkbook (.xlsx)
    finally:
        excel.Quit()
        pythoncom.CoUninitialize()


def make_deck(path: str) -> None:
    """Three slides, big enough to read in the strip-scaled PDF."""
    pythoncom.CoInitialize()
    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        pres = ppt.Presentations.Add(WithWindow=False)
        texts = [
            ("Deck for Folio", "One PDF from three slides"),
            ("What it checks", "Presentations.Open ReadOnly, "
                               "WithWindow:=False, SaveAs ppSaveAsPDF"),
            ("That is all", "Deck done. Back to work."),
        ]
        for i, (title, body) in enumerate(texts, start=1):
            slide = pres.Slides.Add(i, 12)  # ppLayoutBlank
            box = slide.Shapes.AddTextbox(1, 60, 80, 480, 90)
            box.TextFrame.TextRange.Text = title
            box.TextFrame.TextRange.Font.Size = 40
            para = slide.Shapes.AddTextbox(1, 60, 190, 480, 80)
            para.TextFrame.TextRange.Text = body
            para.TextFrame.TextRange.Font.Size = 20
        pres.SaveAs(path, 24)  # ppSaveAsOpenXMLPresentation (.pptx)
    finally:
        ppt.Quit()
        pythoncom.CoUninitialize()


def main() -> None:
    os.makedirs(SAMPLES, exist_ok=True)
    try:
        make_report(os.path.join(SAMPLES, "report.docx"))
        print("report.docx")
        make_report(os.path.join(SAMPLES, "locked.docx"), password="notes")
        print("locked.docx")
        make_wide_sheet(os.path.join(SAMPLES, "wide-table.xlsx"))
        print("wide-table.xlsx")
        make_deck(os.path.join(SAMPLES, "deck.pptx"))
        print("deck.pptx")
    finally:
        pass

    with open(os.path.join(SAMPLES, "corrupt.docx"), "wb") as fh:
        fh.write(b"not a zip file at all, just plain bytes " * 40)
    print("corrupt.docx")

    with open(os.path.join(SAMPLES, "notes.md"), "w",
              encoding="utf-8") as fh:
        fh.write("# Session notes\r\n\r\n"
                 "## Morning\r\n\r\n- reviewed the lab sheet\r\n"
                 "- planned the build\r\n\r\n"
                 "## Afternoon\r\n\r\n1. wired the tool\r\n"
                 "2. tested with Word files\r\n\r\n"
                 "Plain markdown, no pandoc installed here, so Folio "
                 "hands this to Word as text.\r\n")
    print("notes.md")

    with open(os.path.join(SAMPLES, "hello.txt"), "w",
              encoding="utf-8") as fh:
        fh.write("Hello from a plain text file.\r\nLine two, still plain.\r\n")
    print("hello.txt")


if __name__ == "__main__":
    main()
