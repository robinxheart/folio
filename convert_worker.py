"""One-file Office-to-PDF converter, run in its OWN process.

convert_ops.py calls:  python convert_worker.py <input> <output> <kind>

A fresh, isolated win32com instance is created here (DispatchEx), never the
user's open Office window. `pythoncom.CoInitialize()` is called on this
thread because the process may start detached from main(). Every app object
is Quit inside `finally` so a hung conversion cannot leave Office running.

Prints exactly one JSON line as the last line of stdout:
    {"ok": true, "output": "<path>"}          on success
    {"ok": false, "error": "<readable copy>"} on failure
"""

from __future__ import annotations

import http.client  # noqa: F401  (keeps win32com happy on some builds)
import json
import os
import sys


def _readable_com_error(exc) -> str:
    """Map a COM failure to Folio's voice. Words in the message decide."""
    text = ""
    try:
        text = str(exc.args[-1][2]) if len(exc.args) > 2 and exc.args[-1] else str(exc)
    except Exception:  # noqa: BLE001
        text = str(exc)
    text = (text or "").lower()
    if "password" in text or "protected" in text:
        return "This file is password-protected. Remove the password and convert it again."
    return "This file can't be read. It may be damaged."


def _run_word(src: str, out: str) -> None:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        app = win32com.client.DispatchEx("Word.Application")
        try:
            app.Visible = False
            try:
                app.DisplayAlerts = 0
            except Exception:  # noqa: BLE001
                pass
            try:
                app.AutomationSecurity = 3  # stop macro prompts dead
            except Exception:  # noqa: BLE001
                pass
            # A dummy PasswordDocument is ignored for unprotected files and
            # makes protected ones fail fast instead of showing a hidden
            # password dialog that would hang (the spec test case).
            doc = app.Documents.Open(
                src, ReadOnly=True, ConfirmConversions=False,
                AddToRecentFiles=False, PasswordDocument="folio-wrong-password",
            )
            try:
                doc.SaveAs2(out, FileFormat=17)  # wdFormatPDF
            finally:
                doc.Close(False)
        finally:
            app.Quit()
    finally:
        pythoncom.CoUninitialize()


def _run_excel(src: str, out: str) -> None:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        app = win32com.client.DispatchEx("Excel.Application")
        try:
            app.Visible = False
            try:
                app.DisplayAlerts = False
            except Exception:  # noqa: BLE001
                pass
            try:
                app.AutomationSecurity = 3
            except Exception:  # noqa: BLE001
                pass
            wb = app.Workbooks.Open(src, ReadOnly=True)
            try:
                # Keep wide tables whole: every sheet one page wide, as
                # many pages tall as the data needs.
                for ws in wb.Worksheets:
                    setup = ws.PageSetup
                    setup.Zoom = False
                    setup.FitToPagesWide = 1
                    setup.FitToPagesTall = False
                wb.ExportAsFixedFormat(0, out)  # xlTypePDF
            finally:
                wb.Close(False)
        finally:
            app.Quit()
    finally:
        pythoncom.CoUninitialize()


def _run_powerpoint(src: str, out: str) -> None:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        app = win32com.client.DispatchEx("PowerPoint.Application")
        try:
            try:
                app.DisplayAlerts = 1  # ppAlertsNone (older builds: ignore)
            except Exception:  # noqa: BLE001
                pass
            pres = app.Presentations.Open(src, ReadOnly=True, WithWindow=False)
            try:
                pres.SaveAs(out, 32)  # ppSaveAsPDF
            finally:
                pres.Close()
        finally:
            app.Quit()
    finally:
        pythoncom.CoUninitialize()


_RUNNERS = {"word": _run_word, "excel": _run_excel, "powerpoint": _run_powerpoint}


def main() -> int:
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "error": "Bad worker call."}), flush=True)
        return 2
    src, out, kind = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        _RUNNERS[kind](src, out)
        print(json.dumps({"ok": True, "output": out}), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001  (known COM shapes become copy)
        print(json.dumps({"ok": False, "error": _readable_com_error(exc)}), flush=True)
        return 0


if __name__ == "__main__":
    sys.exit(main())
