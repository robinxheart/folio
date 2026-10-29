"""Convert-to-PDF orchestration (parent side, imported by server.py).

Format -> converter by extension:
    Word        .doc .docx .rtf .txt .html .htm .odt
    Excel       .xls .xlsx .xlsm .csv .ods
    PowerPoint  .ppt .pptx .odp
    Images      .jpg .jpeg .png .bmp .webp -> pdf_ops.images_to_pdf (Pillow)
    .md         pandoc if installed, otherwise plain text through Word

Every Office conversion runs in a separate worker process
(`convert_worker.py`, a fresh win32com instance, not the user's open
Office window) with a 120 s timeout. One conversion at a time, guarded by
a module-level lock. On timeout the worker AND the Office instance it
started are killed; the user's own Office windows are left alone because
they were started earlier and know nothing about this export.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import winreg


class ConvertError(Exception):
    """A conversion failed with a copy string ready to send."""


ROOT = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(ROOT, "convert_worker.py")

DOC_EXTS = {
    "word": (".doc", ".docx", ".rtf", ".txt", ".html", ".htm", ".odt"),
    "excel": (".xls", ".xlsx", ".xlsm", ".csv", ".ods"),
    "powerpoint": (".ppt", ".pptx", ".odp"),
}

# Images and .md are served by other paths (Pillow / pandoc-then-Word).
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
MD_EXTS = (".md",)

APP_LABEL = {"word": "Word", "excel": "Excel", "powerpoint": "PowerPoint"}

CONVERT_EXTS: tuple[str, ...] = tuple(sorted(set(
    ext
    for exts in (*DOC_EXTS.values(), IMAGE_EXTS, MD_EXTS)
    for ext in exts
)))

TIMEOUT = 120
_ONE_AT_A_TIME = threading.Lock()


# --------------------------------------------------------------------------
# availability
# --------------------------------------------------------------------------

def _registry_app_installed(exe_name: str) -> bool:
    """True when <exe_name> is on this machine (App Paths registry keys)."""
    key_path = (r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
                "\\" + exe_name)
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, key_path) as key:
                value, _kind = winreg.QueryValueEx(key, "")
        except OSError:
            continue
        path = str(value).strip().strip('"')
        if os.path.isfile(path):
            return True
    return False


def check_converters() -> dict[str, bool]:
    return {
        "word": _registry_app_installed("winword.exe"),
        "excel": _registry_app_installed("excel.exe"),
        "powerpoint": _registry_app_installed("powerpnt.exe"),
        "pandoc": shutil.which("pandoc") is not None,
    }


# --------------------------------------------------------------------------
# one conversion
# --------------------------------------------------------------------------

def run_office(src: str, out_path: str, kind: str, base: str) -> None:
    """One file through its converter app, in its own process, on the lock."""
    with _ONE_AT_A_TIME:
        # Windows FILETIME equivalent of "now": PowerShell compares process
        # start times against this, so only instances born with this
        # conversion are killed on timeout - never the user's open Word.
        cutoff = (int(time.time()) + 11_644_473_600) * 10_000_000
        try:
            proc = subprocess.run(
                [sys.executable, WORKER, src, out_path, kind],
                timeout=TIMEOUT, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
        except subprocess.TimeoutExpired:
            _kill_office_started_after(cutoff)
            raise ConvertError(
                f"Converting {base} took too long and was stopped.") from None
        if proc.returncode != 0:
            raise ConvertError("This file can't be read. It may be damaged.")
        lines = [line for line in (proc.stdout or "").splitlines() if line.strip()]
        try:
            reply = json.loads(lines[-1]) if lines else {}
        except ValueError:
            reply = {}
        if not reply.get("ok"):
            raise ConvertError(reply.get("error")
                               or "This file can't be read. It may be damaged.")
        if not os.path.isfile(out_path):
            raise ConvertError("This file can't be read. It may be damaged.")


def _kill_office_started_after(cutoff_filetime: int) -> None:
    """Stop Office instances this conversion started. Filtering on start
    time leaves the user's open Word (spawned long before) untouched."""
    command = (
        "Get-Process WINWORD,EXCEL,POWERPNT -ErrorAction SilentlyContinue | "
        f"Where-Object {{ $_.StartTime -and $_.StartTime.ToFileTime() -gt {cutoff_filetime} }} | "
        "Stop-Process -Force"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            timeout=30, capture_output=True,
        )
    except Exception:  # noqa: BLE001  (best effort; nothing else depends on it)
        pass


def _pandoc_to_docx(base: str, src: str, out_path: str) -> bool:
    """pandoc writes .docx without needing LaTeX; Word does the last mile.
    Returns False when pandoc failed for this file."""
    tmp_docx = f"{os.path.splitext(out_path)[0]}.pandoc.docx"
    try:
        subprocess.run(
            ["pandoc", src, "-o", tmp_docx],
            timeout=60, capture_output=True, check=True,
        )
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        try:
            os.remove(tmp_docx)
        except OSError:
            pass
        return False
    try:
        run_office(tmp_docx, out_path, "word", base)
    finally:
        try:
            os.remove(tmp_docx)
        except OSError:
            pass
    return True


def _md_as_plain_text(src: str, out_path: str, base: str) -> None:
    """No pandoc (or pandoc failed): hand Word the markdown as plain text.
    Word's converter does not recognise the .md extension, so we present
    it as .txt - the content bytes are unchanged."""
    txt = f"{os.path.splitext(out_path)[0]}.plain.txt"
    with open(src, "rb") as reader:
        with open(txt, "wb") as writer:
            writer.write(reader.read())
    try:
        run_office(txt, out_path, "word", base)
    finally:
        try:
            os.remove(txt)
        except OSError:
            pass


def convert_one(src: str, out_path: str, ext: str, base: str,
                converters: dict) -> None:
    """Convert a single document file to PDF at out_path.

    Images merge elsewhere (pdf_ops.images_to_pdf); .md routes through
    pandoc when installed, otherwise to Word as plain text.
    """
    if ext == ".md":
        if converters.get("pandoc"):
            if _pandoc_to_docx(base, src, out_path):
                return
        _md_as_plain_text(src, out_path, base)
        return
    kind = next((k for k, exts in DOC_EXTS.items() if ext in exts), None)
    if not kind:
        raise ConvertError("Only Word, Excel, PowerPoint and image files work here.")
    if not converters.get(kind):
        raise ConvertError(
            f"{APP_LABEL[kind]} is needed to convert this file. "
            f"Install {APP_LABEL[kind]} and try again.")
    run_office(src, out_path, kind, base)
