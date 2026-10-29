/* Folio - PDF toolkit. Phase 1: shell, merge + info. Phase 2: split,
   extract, delete, rotate and images to PDF. Phase 3: convert to PDF
   (Word, Excel, PowerPoint and more) via Microsoft Office.
   Vanilla JS, no frameworks. Copy follows DESIGN.md throughout. */

"use strict";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  let v = n;
  const units = ["KB", "MB", "GB"];
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[u]}`;
}

function fmtPages(n) {
  return n === 1 ? "1 page" : `${Number(n).toLocaleString("en")} pages`;
}

function pagesWord(n) {
  return n === 1 ? "1 page" : `${n} pages`;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function shortName(name, max = 30) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = Math.max(6, max - ext.length - 1);
  if (base.length <= keep) return name;
  const tail = Math.min(4, keep - 2);
  return `${base.slice(0, keep)}…${base.slice(-tail)}${ext}`;
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const pdfOK = typeof pdfjsLib !== "undefined";
if (pdfOK) pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

/* Shared guards: no request hangs forever, no upload sneaks past the
   server's 100 MB limit, and page sheets render only when they scroll
   near the viewport (the strip with a 200-page file stays smooth). */
const REQUEST_TIMEOUT_MS = 120000;
const CLIENT_UPLOAD_LIMIT = 100 * 1024 * 1024;
/* Watched against the strip's own scroll box (root), widened by 600px on
   each side: a margin on the viewport root can't see past the strip's
   overflow clipping, so the line itself must be the root. */
const LAZY_ROOT_MARGIN = "0px 600px 0px 600px";

const normRotation = (deg) => ((deg % 360) + 360) % 360;

/* Content-Disposition -> the file's own name: prefer the RFC 5987
   filename* parameter (unicode-safe), fall back to plain filename. */
function headerFileName(header, fallback) {
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename\n?\s*=\n?\s*"?([^"_;]+)"?/i.exec(header);
  return (plain && plain[1]) || fallback;
}

const allIndices = (count) => Array.from({ length: count }, (_, i) => i);

/* ------------------------------------------------------------------ */
/* copy (from DESIGN.md, one voice everywhere)                         */
/* ------------------------------------------------------------------ */

const COPY = {
  wrongType: (ext) => `Only PDF files work here. This one is a .${ext}.`,
  wrongTypeConvert: (ext) =>
    `Only Word, Excel, PowerPoint and image files work here. This one is a .${ext}.`,
  locked: "This PDF is locked. Enter its password to continue.",
  corrupt: "This PDF can't be read. It may be damaged.",
  badImage: "This image can't be read. It may be damaged.",
  emptyFile: "This PDF is empty.",
  emptyImage: "This image is empty.",
  emptyConvert: "This file is empty.",
  tooLarge: "This upload is too large. The limit is 100 MB.",
  serverDown: "Can't reach the local server. Start it with `python server.py` and refresh.",
  serverDownShort: "Can't reach the local server.",
  slow: "This took too long and was stopped. Try again.",
  chooseTwo: "Choose two or more PDFs to merge.",
  chooseExtract: "Choose the pages to extract.",
  chooseDelete: "Choose the pages to delete.",
  chooseCut: "Choose at least one cut line. Click between two pages.",
  chooseAngle: "Choose 90, 180 or 270 degrees.",
  deleteAll: "This would leave no pages. Keep at least one.",
  scanned: "No text found. This PDF looks like a scan, so there is nothing to copy yet.",
  merged: "Merged.",
  startMerge: "Merge PDFs",
  hintMergeOrder: "Alt+Left or Alt+Right moves this file in the merge order.",
  hintImageOrder: "Alt+Left or Alt+Right moves this image in the page order.",
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let idSeq = 1;
let rovingPos = 0;        // roving tab index across merge/to-pdf sheets
let dragEntry = null;
let dropTargetIdx = null;

const merge = { files: [], resultUrl: null, resultName: null, working: false };
const info = { file: null };
/* Convert to PDF: files is a mixed queue. Images render on the strip,
   any document switches the whole panel to file rows. */
const convert = { files: [], resultUrl: null, resultName: null, working: false };

const pdfTools = {};

/* Definitions for the single-file tools. "select" tools pick pages,
   "cuts" tools place cut lines, "run" tools act on the whole file. */
const PDF_TOOLS = {
  extract: { endpoint: "/api/extract", button: "Extract pages",
             emptyMsg: COPY.chooseExtract, mode: "select" },
  delete:  { endpoint: "/api/delete", button: "Delete pages",
             emptyMsg: COPY.chooseDelete, mode: "select" },
  rotate:  { endpoint: "/api/rotate", button: "Rotate pages",
             emptyMsg: COPY.chooseAngle, mode: "select", angle: true },
  split:   { endpoint: "/api/split", button: "Split PDF",
             emptyMsg: COPY.chooseCut, mode: "cuts" },
  compress: { endpoint: "/api/compress", button: "Compress PDF",
              emptyMsg: "", mode: "run" },
  lock:    { endpoint: "/api/lock", button: "Add password",
             emptyMsg: "", mode: "run" },
  unlock:  { endpoint: "/api/unlock", button: "Remove password",
             emptyMsg: "", mode: "run", lateOptions: true },
  text:    { endpoint: "/api/text", button: "Extract text",
             emptyMsg: "", mode: "run" },
  watermark: { endpoint: "/api/watermark", button: "Add watermark",
               emptyMsg: "", mode: "run" },
};

const SINGLE_PDF_TOOLS = ["extract", "delete", "rotate", "split",
                          "compress", "lock", "unlock", "text", "watermark"];

/* Which kind of file each drop zone takes. */
const KIND = {
  merge: "pdf", info: "pdf", extract: "pdf", delete: "pdf",
  rotate: "pdf", split: "pdf", "to-pdf": "convert",
  compress: "pdf", lock: "pdf", unlock: "pdf", text: "pdf",
  watermark: "pdf", edit: "pdf",
};

function toolState(tool) {
  if (!pdfTools[tool]) {
    pdfTools[tool] = {
      entry: null, working: false, resultUrl: null, resultName: null,
      sel: new Set(),            // 0-based page indices (extract/delete/rotate)
      cutSel: new Set(),          // cut positions, 1-based (split)
      cutNodes: [],
      pendingDeg: null, extraDeg: {}, turnSeq: 0,
      shown: {}, baseRot: {},
      anchor: null,               // last plain-clicked page (shift-click range)
      badRange: false, done: false,
      level: "standard",         // compress choice
      locked: false,             // unlock: the entry needs a password
      textData: null,            // text: last extraction ({total, pages, scanned})
    };
  }
  return pdfTools[tool];
}

function toolEntries(tool) {
  if (tool === "merge") return merge.files;
  if (tool === "info") return info.file ? [info.file] : [];
  if (tool === "to-pdf") return convert.files;
  const state = pdfTools[tool];
  return state && state.entry ? [state.entry] : [];
}

function makeEntry(file, tool) {
  return {
    id: idSeq++, file, tool, name: file.name, size: file.size,
    doc: null, pageCount: null, group: null, pagesEl: null,
    captionMeta: null, pageNodes: [], dead: false, loading: false,
  };
}

function closeDoc(entry) {
  stopWatchingEntry(entry);   // the lazy renderer forgets detached sheets
  releaseDocData(entry);      // pdf.js input data leaves memory with the file
  if (entry.doc) { try { entry.doc.destroy(); } catch { /* already destroyed */ } }
  entry.doc = null;
}

/* ------------------------------------------------------------------ */
/* page ranges (1-based "1-3,5,8-"; mirrors the server parser)         */
/* ------------------------------------------------------------------ */

function parsePageRange(spec, total) {
  const text = String(spec || "").trim();
  if (!text) return { indices: [], error: null };
  const found = new Set();
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const m = /^(\d+)(-(\d*))?$/.exec(token);
    if (!m) return { indices: [], error: `"${token}" is not a page range. Use 1-3,5,8-.` };
    const first = Number(m[1]);
    let second;
    if (m[2] === undefined) second = first;         // "5"
    else if (m[3] === undefined || m[3] === "") second = total; // "5-"
    else second = Number(m[3]);                     // "5-8"
    if (second < first) {
      return { indices: [], error: `"${token}" is not a page range. Use 1-3,5,8-.` };
    }
    if (first < 1 || second > total) {
      return { indices: [], error: `"${token}" is outside this file. It has ${pagesWord(total)}.` };
    }
    for (let p = first; p <= second; p += 1) found.add(p - 1);
  }
  return { indices: [...found].sort((a, b) => a - b), error: null };
}

function canonicalRange(indices, total) {
  if (!indices.length) return "";
  const runs = [];
  let start = indices[0];
  let prev = indices[0];
  for (let i = 1; i <= indices.length; i += 1) {
    const cur = indices[i];
    if (cur !== prev + 1) { runs.push([start, prev]); start = cur; }
    prev = cur;
  }
  return runs.map(([a, b]) => {
    if (a === b) return String(a + 1);
    if (b === total - 1) return `${a + 1}-`;
    return `${a + 1}-${b + 1}`;
  }).join(",");
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const THEME_KEY = "folio-theme";

function setTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  $$(".theme-toggle").forEach((btn) => {   /* Folio: the toggle lives on both views */
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  });
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ } }
}

function initTheme() {
  const param = new URLSearchParams(location.search).get("theme");
  if (param === "light" || param === "dark") { setTheme(param, false); return; }
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === "light" || saved === "dark") { setTheme(saved, false); return; }
  setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", false);
}

/* ------------------------------------------------------------------ */
/* tools + panels                                                      */
/* ------------------------------------------------------------------ */

/* Folio: the ten routes. Protect is one view with two tabs; the legacy
   ?tool= URLs become hash routes in boot(). */
/* Tools with tabs inside their panel. The panel is `panel-<tool>`; each
   tab button is `<tool>-tab-<name>` and shows the sub-panel named in
   TAB_GROUPS (Protect started this pattern; Pages and Text share it). */
const TAB_GROUPS = {
  protect: { lock: "panel-lock", unlock: "panel-unlock" },
  pages: { extract: "panel-extract", delete: "panel-delete" },
  text: { read: "panel-text-read", edit: "panel-text-edit" },
};
const subTabs = {};   // tool -> { current, pending } (pending set by routes)

const TOOL_IDS = ["merge", "split", "pages", "rotate", "compress",
  "text", "watermark", "protect", "to-pdf", "info"];

function panelTitle(tool) {
  const title = $(`#panel-${tool} .wb__title`);
  return title ? title.textContent : tool;
}

function subTabState(tool) {
  if (!subTabs[tool]) {
    subTabs[tool] = { current: Object.keys(TAB_GROUPS[tool])[0], pending: null };
  }
  return subTabs[tool];
}

function showTool(tool) {
  $$(".wb__panel:not(.wb__sub)").forEach((panel) => { panel.hidden = panel.id !== `panel-${tool}`; });
  const title = panelTitle(tool);
  document.title = `Folio — ${title}`;
  const crumb = $("#tool-title");
  if (crumb) crumb.textContent = title;
  if (TAB_GROUPS[tool]) {
    const st = subTabState(tool);
    setSubTab(tool, st.pending || st.current);
    st.pending = null;
  }
}

function setSubTab(tool, tab) {
  const group = TAB_GROUPS[tool];
  const st = subTabState(tool);
  if (!group || !(tab in group)) tab = Object.keys(group)[0];
  st.current = tab;
  for (const name of Object.keys(group)) {
    const tabBtn = $(`#${tool}-tab-${name}`);
    const panel = $(`#${group[name]}`);
    if (!tabBtn || !panel) continue;
    const on = name === tab;
    tabBtn.setAttribute("aria-selected", String(on));
    tabBtn.tabIndex = on ? 0 : -1;
    tabBtn.classList.toggle("is-active", on);
    panel.hidden = !on;
  }
}

function wireSubTabs(tool) {
  const bar = $(`#panel-${tool} .tabs`);
  if (!bar) return;
  const names = Object.keys(TAB_GROUPS[tool] || {});
  $$(`#panel-${tool} [role='tab']`).forEach((t) => {
    t.addEventListener("click", () => setSubTab(tool, t.dataset.tab));
  });
  bar.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    ev.preventDefault();
    const i = names.indexOf(subTabState(tool).current);
    const next = names[(i + (ev.key === "ArrowRight" ? 1 : names.length - 1)) % names.length];
    setSubTab(tool, next);
    $(`#${tool}-tab-${next}`).focus();
  });
}

/* ------------------------------------------------------------------ */
/* status + notices                                                    */
/* ------------------------------------------------------------------ */

function setNotice(tool, message) {
  const box = $(`#${tool}-notice`);
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function clearNotice(tool) {
  const box = $(`#${tool}-notice`);
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
}

function setStatus(tool, text, ok) {
  const line = $(`#${tool}-status`);
  if (!line) return;
  line.textContent = text;
  line.classList.toggle("actionbar__status--ok", Boolean(ok));
}

/* The "server down" message appears once per outage: the first request
   that fails without a reply gets the notice, and every later one while
   the outage continues settles for the quiet status line. Any reply at
   all - even an error reply - proves the server is back and resets it. */
let serverLost = false;

function markServerOkay() { serverLost = false; }

function loseServer(tool) {
  if (serverLost) { setStatus(tool, COPY.serverDownShort, false); return; }
  serverLost = true;
  setNotice(tool, COPY.serverDown);
}

/* Determinate bar + progressbar ARIA state shared by every uploader. */
function paintProgress(progress, ev) {
  const pct = ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0;
  $(".progress__bar", progress).style.width = `${Math.min(100, pct)}%`;
  progress.setAttribute("aria-valuenow", String(Math.min(100, pct)));
  if (ev.loaded >= ev.total) progress.classList.add("is-indeterminate");
}

/* ------------------------------------------------------------------ */
/* page strip builders                                                 */
/* ------------------------------------------------------------------ */

function svgIcon(id, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls || "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.appendChild(use);
  return svg;
}

/* Page interaction mode: "rove" (merge/images), "select" (page picking),
   or false (plain sheet). */
function pageModeOf(tool) {
  if (tool === "merge" || tool === "to-pdf") return "rove";
  if (tool === "extract" || tool === "delete" || tool === "rotate") return "select";
  return false;
}

function makePageNode(entry, pageIdx, mode) {
  const interactive = mode !== false;
  const wrap = interactive ? el("button", "strip__page") : el("div", "strip__page");
  if (interactive) {
    wrap.type = "button";
    if (mode === "rove") {
      wrap.setAttribute("draggable", "true");
      wrap.tabIndex = -1;
      wrap.addEventListener("keydown", onSheetKey);
    } else if (mode === "select") {
      wrap.classList.add("strip__page--select");
    }
  } else {
    wrap.setAttribute("role", "img");
  }
  const node = { btn: wrap, sheet: el("span", "strip__sheet is-loading"),
                 label: el("span", "strip__label", "–") };
  wrap.appendChild(node.sheet);
  wrap.appendChild(node.label);
  wrap.dataset.file = String(entry.id);
  wrap.dataset.page = String(pageIdx);
  return node;
}

function buildGroup(entry, { alone = false, caption = false }) {
  const group = el("div", alone ? "strip__group strip__group--alone" : "strip__group");
  const pages = el("div", "strip__pages");
  group.appendChild(pages);

  if (caption) {
    const cap = el("div", "strip__caption");
    const name = el("span", "strip__filename", shortName(entry.name));
    name.title = entry.name;
    const meta = el("span", "strip__meta", fmtBytes(entry.size));
    const remove = el("button", "iconbtn strip__remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${entry.name}`);
    remove.title = `Remove ${entry.name}`;
    remove.appendChild(svgIcon("i-x"));
    remove.addEventListener("click", () => removeFile(entry, entry.tool));
    cap.appendChild(name);
    cap.appendChild(meta);
    cap.appendChild(remove);
    group.appendChild(cap);
    entry.captionMeta = meta;
  }

  entry.group = group;
  entry.pagesEl = pages;
  return group;
}

function skeletonInto(entry) {
  entry.pagesEl.replaceChildren();
  entry.pageNodes = [makePageNode(entry, 0, pageModeOf(entry.tool))];
  entry.pagesEl.appendChild(entry.pageNodes[0].btn);
}

function buildCuts(entry, state) {
  const nodes = entry.pageNodes;
  const mixed = [];
  state.cutNodes = [];
  nodes.forEach((node, i) => {
    mixed.push(node.btn);
    if (i < nodes.length - 1) {
      const cut = el("button", "strip__cut");
      cut.type = "button";
      cut.dataset.cut = String(i + 1); // the cut sits after page i+1 (1-based)
      cut.setAttribute("aria-pressed", "false");
      cut.setAttribute("aria-label", `Split after page ${i + 1}`);
      cut.title = `Split after page ${i + 1}`;
      mixed.push(cut);
      state.cutNodes.push(cut);
    }
  });
  entry.pagesEl.replaceChildren(...mixed);
}

function stripLine(tool) { return $(`#${tool}-strip .strip__line`); }
function pageNodesFlat(tool = "merge") { return $$(".strip__page", stripLine(tool)); }

function retab(tool = "merge") {
  const nodes = pageNodesFlat(tool);
  if (rovingPos >= nodes.length) rovingPos = Math.max(0, nodes.length - 1);
  nodes.forEach((node, i) => { node.tabIndex = i === rovingPos ? 0 : -1; });
}

function relabel(tool = "merge") {
  const entries = toolEntries(tool);
  const state = toolState(tool);
  const hint = tool === "merge" ? COPY.hintMergeOrder
    : tool === "to-pdf" ? COPY.hintImageOrder : null;
  const selectMode = PDF_TOOLS[tool] && PDF_TOOLS[tool].mode === "select";
  const totalImages = tool === "to-pdf" ? entries.length : null;
  const groups = $$(".strip__group", stripLine(tool));
  let global = 1;
  groups.forEach((group) => {
    const firstPage = group.querySelector(".strip__page");
    const entry = firstPage
      ? entries.find((e) => String(e.id) === firstPage.dataset.file) : null;
    const alias = entry ? entry.name : "PDF";
    $$(".strip__page", group).forEach((wrap, i) => {
      // Number every page from 1 globally across the strip: identical for a
      // single group (merge, single-file tools), correct page order for the
      // per-image groups of a new Images to PDF batch.
      const num = String(global);
      const label = wrap.querySelector(".strip__label");
      if (label) label.textContent = num;
      if (wrap.getAttribute("role") === "img") {
        const total = totalImages !== null ? String(totalImages) : fmtPageCount(entry);
        wrap.setAttribute("aria-label", `Page ${num} of ${total}, ${alias}`);
      } else if (selectMode) {
        const picked = state.sel.has(i);
        wrap.setAttribute("aria-pressed", String(picked));
        wrap.setAttribute("aria-label", `Page ${num}, ${alias}${picked ? ", selected" : ""}`);
      } else if (hint) {
        wrap.setAttribute("aria-label", `Page ${num}, ${alias}. ${hint}`);
      }
      global += 1;
    });
  });
}

function fmtPageCount(entry) {
  return entry && entry.pageCount ? entry.pageCount : "?";
}

function placeCanvases(entry) {
  const tool = entry.tool;
  const mode = pageModeOf(tool);
  entry.pagesEl.replaceChildren();
  entry.pageNodes = [];
  for (let i = 0; i < entry.pageCount; i += 1) {
    const node = makePageNode(entry, i, mode);
    entry.pageNodes.push(node);
    entry.pagesEl.appendChild(node.btn);
  }
  if (entry.captionMeta) {
    entry.captionMeta.textContent = `${fmtPages(entry.pageCount)}, ${fmtBytes(entry.size)}`;
  }
  relabel(tool);

  // Lazy rendering: sheets paint as they roll into view (plus the first
  // page right away, so the strip answers a drop immediately).
  const observer = wirePageObserver(tool);
  entry.pageNodes.forEach((node) => {
    if (observer) observer.observe(node.btn);
    else renderSheet(entry, Number(node.btn.dataset.page)).catch(() => { /* paper stays */ });
  });
  renderSheet(entry, 0).catch(() => { /* the sheet stays paper */ });

  if (tool === "merge") { mergeStatusDirty(); retab("merge"); }
  else if (tool === "split") {
    buildCuts(entry, toolState(tool));
    setIdleStatus(tool);
    syncControls(tool);
  } else if (PDF_TOOLS[tool]) {
    const state = toolState(tool);
    if (tool === "rotate") {
      state.sel = new Set(allIndices(entry.pageCount)); // empty means all; start honest
      paintSelection(tool);
    }
    if ($(`#${tool}-pages`)) {
      // A range typed while the file was loading applies now that the
      // page count is known (an empty input just settles the idle state).
      applyRangeInput(tool);
    } else {
      setIdleStatus(tool);
      syncControls(tool);
    }
  }
}

/* ------------------------------------------------------------------ */
/* rendering thumbnails (lazy: sheets paint as they come into view)    */
/* ------------------------------------------------------------------ */

/* Every page starts as the same white sheet showing its page number;
   an IntersectionObserver swaps in the real canvas only when the sheet
   approaches the viewport, so a 200-page file never renders 200 pages
   up front. The white sheet with the number is the loading state. */

const DOC_DATA = new Map();       // File -> ArrayBuffer for pdf.js
const pageIO = new Map();         // tool -> IntersectionObserver

function loadedFor(file) { return DOC_DATA.get(file) || null; }

async function ensureDocData(file) {
  if (!DOC_DATA.has(file)) DOC_DATA.set(file, await file.arrayBuffer());
  return DOC_DATA.get(file);
}

function dropDocData(file) { DOC_DATA.delete(file); }

function releaseDocData(entry) { if (entry.file) dropDocData(entry.file); }

function wirePageObserver(tool) {
  if (pageIO.has(tool)) return pageIO.get(tool);
  let observer = null;
  if (typeof IntersectionObserver === "function") {
    const line = $(`#${tool}-strip .strip__line`);
    observer = new IntersectionObserver((hits) => {
      hits.forEach((hit) => { if (hit.isIntersecting) onSheetVisible(hit.target); });
    }, { root: line || null, rootMargin: LAZY_ROOT_MARGIN });
  }
  pageIO.set(tool, observer);
  return observer;
}

function stopWatchingEntry(entry) {
  const observer = pageIO.get(entry.tool);
  if (!observer) return;
  (entry.pageNodes || []).forEach((node) => {
    try { observer.unobserve(node.btn); } catch { /* already gone */ }
  });
}

function onSheetVisible(btn) {
  const strip = btn.closest(".strip");
  if (!strip) return;
  const tool = strip.id.replace(/-strip$/, "");
  const entry = toolEntries(tool).find(
    (e) => e.pageNodes && e.pageNodes.some((n) => n.btn === btn));
  if (!entry || entry.dead || !entry.doc) return;
  const i = entry.pageNodes.findIndex((n) => n.btn === btn);
  renderSheet(entry, i).catch(() => { /* the sheet stays paper */ });
}

/* One sheet's canvas at its current rotation (base + extra + pending).
   `turn` carries a live turn gesture: { delta, seq }. */
async function renderSheet(entry, i, turn = null) {
  const state = toolState(entry.tool);
  if (!entry.doc || entry.dead || !loadedFor(entry.file)) return;
  const node = entry.pageNodes[i];
  if (!node) return;
  const page = await entry.doc.getPage(i + 1);
  if (entry.dead) return;
  const base = page.rotate || 0;
  if (entry.tool === "rotate" && !(i in state.baseRot)) state.baseRot[i] = base;
  let pendingPart = 0;
  if (entry.tool === "rotate" && state.pendingDeg) {
    const affected = new Set(state.sel.size
      ? [...state.sel] : allIndices(entry.pageCount));
    if (affected.has(i)) pendingPart = state.pendingDeg;
  }
  const total = normRotation(base + (state.extraDeg[i] || 0) + pendingPart);
  const vp = page.getViewport({ scale: 1, rotation: total });
  const scale = 220 / vp.width; // 110px sheet, 2x for sharpness
  const canvas = document.createElement("canvas");
  canvas.className = "strip__canvas";
  canvas.width = Math.max(1, Math.round(vp.width * scale));
  canvas.height = Math.max(1, Math.round(vp.height * scale));
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport: page.getViewport({ scale, rotation: total }),
  }).promise;
  if (entry.dead) return;
  if (turn && turn.seq !== state.turnSeq) return; // a newer turn took over
  node.sheet.replaceChildren(canvas);
  node.sheet.classList.remove("is-loading");
  node.vpW = vp.width;    // page size in points at the shown rotation
  node.vpH = vp.height;   // (the watermark preview reads these)
  state.shown[i] = total;
  if (entry.tool === "watermark") paintWmPreview(entry, i, canvas);
  if (turn && turn.delta && !reduceMotion() && Element.prototype.animate) {
    canvas.animate(
      [{ transform: `rotate(${-turn.delta}deg)` }, { transform: "none" }],
      { duration: 200, easing: "ease-out" },
    );
  }
}

async function renderEntry(entry) {
  if (entry.loading || !pdfOK) return;
  entry.loading = true;
  try {
    const data = await ensureDocData(entry.file);
    const doc = await pdfjsLib.getDocument({ data: data.slice(0), isEvalSupported: false }).promise;
    entry.doc = doc;
    entry.pageCount = doc.numPages;
    placeCanvases(entry);
  } catch (err) {
    const locked = err && (err.name === "PasswordException" ||
      (typeof pdfjsLib.PasswordException === "function" && err instanceof pdfjsLib.PasswordException));
    if (locked && entry.tool === "unlock" && !entry.dead) holdLockedEntry(entry);
    else failFile(entry, entry.tool, locked ? COPY.locked : COPY.corrupt);
  } finally {
    entry.loading = false;
    if (PDF_TOOLS[entry.tool]) syncControls(entry.tool);
  }
}

function failFile(entry, tool, message) {
  entry.dead = true;
  if (tool === "merge") {
    merge.files = merge.files.filter((other) => other !== entry);
    if (entry.group) entry.group.remove();
    closeDoc(entry);
    relabel("merge");
    retab("merge");
    mergeStatusDirty();
  } else if (tool === "to-pdf") {
    convertRemoveEntry(entry, true);
    closeDoc(entry);
  } else if (tool === "edit") {
    toolRemoveFile(entry, tool, true);
  } else if (PDF_TOOLS[tool]) {
    toolRemoveFile(entry, tool, true);
  } else {
    info.file = null;
    if (entry.group) entry.group.remove();
    closeDoc(entry);
    $("#info-filerow").hidden = true;
    $("#info-zone").hidden = false;
    $("#info-details").hidden = true;
    setStatus("info", "", false);
    infoStripEmpty(true);
  }
  setNotice(tool, message);
}

/* ------------------------------------------------------------------ */
/* selection + page range sync (extract / delete / rotate)             */
/* ------------------------------------------------------------------ */

function paintSelection(tool) {
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry) return;
  entry.pageNodes.forEach((node, i) => {
    const hit = state.sel.has(i);
    node.btn.classList.toggle(tool === "delete" ? "is-struck" : "is-selected", hit);
    node.btn.setAttribute("aria-pressed", String(hit));
  });
  relabel(tool);
}

function toggleSelect(tool, idx) {
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry || !entry.pageCount || state.working || state.done) return;
  if (state.sel.has(idx)) state.sel.delete(idx);
  else state.sel.add(idx);
  if (tool === "rotate" && !state.sel.size) {
    // The server treats an empty spec as "every page" - show that honestly.
    state.sel = new Set(allIndices(entry.pageCount));
  }
  const input = $(`#${tool}-pages`);
  if (input) {
    input.value = canonicalRange([...state.sel].sort((a, b) => a - b), entry.pageCount);
  }
  state.badRange = false;
  clearNotice(tool);
  paintSelection(tool);
  if (tool === "rotate") syncRotatePreviews();
  setIdleStatus(tool);
  syncControls(tool);
}

function onRangeInput(tool) {
  const state = toolState(tool);
  const entry = state.entry;
  const input = $(`#${tool}-pages`);
  if (!input || state.done) return;
  if (!entry || !entry.pageCount) {
    // The file is still loading: keep what was typed and apply it as
    // soon as the page count is known (placeCanvases calls back).
    state.badRange = false;
    clearNotice(tool);
    syncControls(tool);
    return;
  }
  applyRangeInput(tool);
}

/* Read the range input into the selection; needs the page count. */
function applyRangeInput(tool) {
  const state = toolState(tool);
  const entry = state.entry;
  const input = $(`#${tool}-pages`);
  if (!entry || !entry.pageCount || !input) return;
  const parsed = parsePageRange(input.value, entry.pageCount);
  if (parsed.error) {
    state.badRange = true;
    setNotice(tool, parsed.error);
  } else {
    state.badRange = false;
    clearNotice(tool);
    state.sel = new Set(parsed.indices);
    if (tool === "rotate" && !state.sel.size) {
      state.sel = new Set(allIndices(entry.pageCount)); // empty means all
    }
    paintSelection(tool);
    if (tool === "rotate") syncRotatePreviews();
    setIdleStatus(tool);
  }
  syncControls(tool);
}

function wireSelectStrip(tool) {
  stripLine(tool).addEventListener("click", (ev) => {
    const page = ev.target.closest(".strip__page");
    if (!page) return;
    if (page.dataset.file === undefined) return;
    const state = toolState(tool);
    if (!state.entry || !state.entry.pageNodes) return;
    const idx = state.entry.pageNodes.findIndex((n) => n.btn === page);
    if (idx < 0) return;
    if (ev.shiftKey && state.anchor !== null && state.anchor !== idx) {
      shiftSelect(tool, idx);   // plain click, then shift-click: the range
    } else {
      state.anchor = idx;
      toggleSelect(tool, idx);
    }
  });
}

/* Shift-click: select every page from the last plain click to this one,
   exactly as if the range had been typed into the input. */
function shiftSelect(tool, idx) {
  const state = toolState(tool);
  const entry = state.entry;
  const from = Math.min(state.anchor, idx);
  const to = Math.max(state.anchor, idx);
  const picked = new Set();
  for (let i = from; i <= to; i += 1) picked.add(i);
  state.sel = picked;
  if (tool === "rotate" && !state.sel.size) {
    state.sel = new Set(allIndices(entry.pageCount));
  }
  const input = $(`#${tool}-pages`);
  if (input) {
    input.value = canonicalRange([...state.sel].sort((a, b) => a - b), entry.pageCount);
  }
  state.badRange = false;
  clearNotice(tool);
  paintSelection(tool);
  if (tool === "rotate") syncRotatePreviews();
  setIdleStatus(tool);
  syncControls(tool);
}

/* ------------------------------------------------------------------ */
/* split: cut lines                                                    */
/* ------------------------------------------------------------------ */

function paintCuts() {
  const state = toolState("split");
  state.cutNodes.forEach((cut) => {
    cut.setAttribute("aria-pressed", String(state.cutSel.has(Number(cut.dataset.cut))));
  });
}

function toggleCut(pos) {
  const state = toolState("split");
  if (!state.entry || state.working || state.done) return;
  if (state.cutSel.has(pos)) state.cutSel.delete(pos);
  else state.cutSel.add(pos);
  clearNotice("split");
  paintCuts();
  setIdleStatus("split");
  syncControls("split");
}

function splitMode() {
  const radio = $('input[name="split-mode"]:checked');
  return radio ? radio.value : "parts";
}

function splitPartsCount() {
  const state = toolState("split");
  const entry = state.entry;
  if (!entry || !entry.pageCount) return 0;
  if (splitMode() === "pages") return entry.pageCount;
  return state.cutSel.size ? Math.min(state.cutSel.size + 1, entry.pageCount) : 0;
}

/* ------------------------------------------------------------------ */
/* idle + working + result copy per tool                               */
/* ------------------------------------------------------------------ */

function setIdleStatus(tool) {
  const state = toolState(tool);
  if (state.resultUrl || state.working) return;
  const entry = state.entry;
  if (!entry || !entry.pageCount) { setStatus(tool, "", false); return; }
  let text = `${fmtPages(entry.pageCount)}, ${fmtBytes(entry.size)}`;
  if (tool === "split") {
    const parts = splitPartsCount();
    if (parts) text += ` → ${parts} parts`;
  }
  setStatus(tool, text, false);
}

function workingLabel(tool) {
  const state = toolState(tool);
  const n = state.sel.size;
  switch (tool) {
    case "extract": return `Extracting ${n} ${n === 1 ? "page" : "pages"}...`;
    case "delete": return `Deleting ${n} ${n === 1 ? "page" : "pages"}...`;
    case "rotate": return `Turning ${n} ${n === 1 ? "page" : "pages"}...`;
    case "split": {
      const parts = splitPartsCount();
      return `Splitting into ${parts} parts...`;
    }
    case "to-pdf": {
      const files = convert.files.filter((entry) => !entry.dead);
      const docs = files.some((entry) => entry.cKind !== "image");
      const noun = docs
        ? (files.length === 1 ? "file" : "files")
        : (files.length === 1 ? "image" : "images");
      return `Converting ${files.length} ${noun}...`;
    }
    case "compress": {
      const entry = state.entry;
      return entry ? `Compressing ${shortName(entry.name, 26)}...` : "Compressing...";
    }
    case "lock": return "Adding password...";
    case "unlock": return "Removing the password...";
    case "text": return "Extracting text...";
    default: return "";
  }
}

/* ------------------------------------------------------------------ */
/* rotate: angle buttons + turn gesture                                */
/* ------------------------------------------------------------------ */

function onAngleClick(btn) {
  const state = toolState("rotate");
  const entry = state.entry;
  if (!entry || !entry.pageCount || state.working || state.done || entry.loading) return;
  const deg = Number(btn.dataset.degrees);
  $$(".rot-angle").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  state.pendingDeg = deg;
  clearNotice("rotate");
  syncRotatePreviews();
  syncControls("rotate");
}

/* Reconcile the previews with the pending angle + selection: pages that
   start being affected get one 200ms turn to their new preview; pages
   that stop being affected turn back. */
function syncRotatePreviews() {
  const state = toolState("rotate");
  const entry = state.entry;
  if (!entry || !entry.pageCount || state.done) return;
  const affected = new Set(state.sel.size
    ? [...state.sel].sort((a, b) => a - b)
    : allIndices(entry.pageCount));
  const seq = state.turnSeq + 1;
  state.turnSeq = seq;
  for (let i = 0; i < entry.pageCount; i += 1) {
    if (state.shown[i] === undefined) continue; // first render owns these
    const base = state.baseRot[i] || 0;
    const want = normRotation(base + (state.extraDeg[i] || 0)
      + (state.pendingDeg && affected.has(i) ? state.pendingDeg : 0));
    const shown = state.shown[i];
    if (shown === want) continue;
    let delta = want - shown;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    state.shown[i] = want;
    renderSheet(entry, i, { delta, seq }).catch(() => { /* redraw race */ });
  }
}

function commitRotate(state) {
  const affected = state.sel.size
    ? [...state.sel].sort((a, b) => a - b)
    : allIndices(state.entry.pageCount);
  affected.forEach((i) => {
    state.extraDeg[i] = (state.extraDeg[i] || 0) + (state.pendingDeg || 0);
  });
  state.pendingDeg = null;
  $$(".rot-angle").forEach((b) => b.setAttribute("aria-pressed", "false"));
  syncRotatePreviews(); // should be a visual no-op: shown already includes pending
}

/* ------------------------------------------------------------------ */
/* single-file pdf tools: add / remove / reset                         */
/* ------------------------------------------------------------------ */

function toolAddFile(tool, file) {
  const state = toolState(tool);
  if (state.entry) removeFile(state.entry, tool);
  clearNotice(tool);
  revokeResult(tool);
  const entry = makeEntry(file, tool);
  state.entry = entry;
  if (tool === "info") info.file = entry; // runInfo/removeFile read this alias
  state.done = false;
  state.badRange = false;
  state.anchor = null;
  state.sel = new Set();
  state.cutSel = new Set();
  state.cutNodes = [];
  state.pendingDeg = null;
  state.extraDeg = {};
  state.turnSeq += 1;
  state.shown = {};
  state.baseRot = {};
  state.locked = false;
  state.level = "standard";
  state.textData = null;

  $(`#${tool}-zone`).hidden = true;
  const row = $(`#${tool}-filerow`);
  row.hidden = false;
  $(".filerow__name", row).textContent = shortName(file.name, 44);
  $(".filerow__name", row).title = file.name;
  $(".filerow__meta", row).textContent = fmtBytes(file.size);

  const group = buildGroup(entry, { alone: true, caption: false });
  skeletonInto(entry);
  stripLine(tool).appendChild(group);

  const options = $(`#${tool}-options`);
  if (options && !(PDF_TOOLS[tool] && PDF_TOOLS[tool].lateOptions)) options.hidden = false;
  if (tool === "compress") compressLevelUI("standard");
  if (tool === "lock") syncLockHint();
  const pagesInput = $(`#${tool}-pages`);
  if (pagesInput) pagesInput.value = "";

  if (tool === "info") {
    $("#info-details").hidden = true;
    setStatus("info", "Reading file...", false);
    renderEntry(entry);
    runInfo();
  } else if (tool === "edit") {
    // The strip and the page view come up after the span fetch: a
    // locked file needs its password before pdf.js can open it at all.
    editStart(entry);
  } else {
    setStatus(tool, "Reading file...", false);
    renderEntry(entry);
  }
  syncControls(tool);
}

function toolRemoveFile(entry, tool, failed = false) {
  const state = toolState(tool);
  state.working = false;
  state.entry = null;
  state.done = false;
  state.badRange = false;
  state.anchor = null;
  state.sel = new Set();
  state.cutSel = new Set();
  state.cutNodes = [];
  state.pendingDeg = null;
  state.extraDeg = {};
  state.turnSeq += 1;
  state.shown = {};
  state.baseRot = {};
  state.locked = false;
  state.textData = null;
  revokeResult(tool);
  if (entry.group) entry.group.remove();
  closeDoc(entry);

  $(`#${tool}-zone`).hidden = false;
  $(`#${tool}-filerow`).hidden = true;
  const optionsRow = $(`#${tool}-options`);
  if (optionsRow) optionsRow.hidden = true;
  const pagesInput = $(`#${tool}-pages`);
  if (pagesInput) { pagesInput.value = ""; pagesInput.disabled = false; }
  $$(`#${tool}-options .rot-angle`).forEach((b) => { b.disabled = false; });
  $$(`#${tool}-options .compress-level`).forEach((b) => { b.disabled = false; });
  $$(`#${tool}-options input[name="split-mode"]`).forEach((r) => { r.disabled = false; });
  const cuts = state.cutNodes; // disabled while a result was showing
  cuts.forEach((cut) => { cut.disabled = false; });
  const progress = $(`#${tool}-progress`);
  if (progress) { progress.hidden = true; progress.classList.remove("is-indeterminate"); }
  if (tool === "split") {
    // Start over puts the mode back where it began.
    const parts = $('input[name="split-mode"][value="parts"]');
    if (parts) parts.checked = true;
    $("#split-hint").textContent = "Click between two pages to add a cut line.";
  }
  // Password fields are never kept after a file leaves (locked-in copy:
  // the typed password goes out of memory with the file).
  $$(`#${tool}-options input[type="password"]`).forEach((inp) => {
    inp.value = "";
    inp.type = "password";
    inp.disabled = false;
  });
  $$(`#${tool}-options .field__eye`).forEach(resetEye);
  if (tool === "lock") syncLockHint();
  if (tool === "unlock" && optionsRow) {
    optionsRow.hidden = true; // the field only shows once a lock is found
    $("#unlock-hint").hidden = true;
  }
  if (tool === "watermark") resetWatermarkFields();
  if (tool === "edit") resetEditState();
  const copyBtn = $(`#${tool}-copy`);
  if (copyBtn) copyBtn.hidden = true;
  const note = $(`#${tool}-note`);
  if (note) { note.hidden = true; note.textContent = ""; }
  const details = $(`#${tool}-details`);
  if (details) details.hidden = true;
  const box = $(`#${tool}-box`);
  if (box) box.replaceChildren();
  const go = $(`#${tool}-go`);
  if (go) go.textContent = PDF_TOOLS[tool] ? PDF_TOOLS[tool].button : go.dataset.label;
  clearNotice(tool);
  setStatus(tool, "", false);
  syncControls(tool);
}

function revokeResult(tool) {
  const state = toolState(tool);
  const holder = tool === "to-pdf" ? convert : state;
  if (holder.resultUrl) URL.revokeObjectURL(holder.resultUrl);
  holder.resultUrl = null;
  holder.resultName = null;
}

function resetTool(tool) {
  const state = toolState(tool);
  if (state.entry) {
    state.entry.dead = true;
    toolRemoveFile(state.entry, tool);
  }
}

/* Shared enablement of the action row for the single-file tools. */
function syncControls(tool) {
  const state = toolState(tool);
  const def = PDF_TOOLS[tool];
  if (!def) return;
  const entry = state.entry;
  const go = $(`#${tool}-go`);
  const hasResult = Boolean(state.resultUrl);
  let ready = Boolean(entry && !state.working && !state.badRange
    && !state.done && !entry.loading && !entry.dead);
  if (tool === "unlock" && state.locked) {
    // A held locked file has no page thumbnails; the typed password carries it.
    ready = ready && $("#unlock-password").value.length > 0;
  } else {
    ready = ready && Boolean(entry && entry.pageCount);
  }
  if (def.mode === "select") {
    if (tool === "rotate") ready = ready && state.pendingDeg !== null;
    else ready = ready && state.sel.size > 0;
  } else if (def.mode === "cuts") {
    ready = ready && (splitMode() === "pages" || state.cutSel.size > 0);
  } else if (tool === "lock") {
    ready = ready && lockPasswordsMatch();
  } else if (tool === "watermark") {
    ready = ready && watermarkReady();
  }
  go.hidden = hasResult || Boolean(state.textData);
  go.disabled = !ready;
  $(`#${tool}-download`).hidden = !hasResult;
  $(`#${tool}-reset`).hidden = !hasResult;
}

/* After extract/delete: fade out the pages that are not in the output
   and relabel the rest 1..k (DESIGN.md: page delete fade 150ms). */
function finishPageSet(tool, kept) {
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry) return;
  const keptSet = new Set(kept);
  const removals = [];
  const lazy = pageIO.get(tool);
  entry.pageNodes.forEach((node, i) => {
    if (!keptSet.has(i)) {
      if (lazy) { try { lazy.unobserve(node.btn); } catch { /* gone */ } }
      removals.push(node);
    }
  });
  entry.pageNodes = entry.pageNodes.filter((_, i) => keptSet.has(i));
  state.sel = new Set(); // the result view is not a selection
  const waiters = [];
  if (reduceMotion() || !Element.prototype.animate) {
    removals.forEach((node) => node.btn.remove());
  } else {
    removals.forEach((node) => {
      const anim = node.btn.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 150, easing: "ease-out" },
      );
      waiters.push(
        anim.finished.catch(() => { /* e.g. reduced motion flip */ })
          .then(() => { if (node.btn.isConnected) node.btn.remove(); }),
      );
    });
  }
  entry.pageNodes.forEach((node) => {
    node.btn.classList.remove("is-selected", "is-struck");
    node.btn.setAttribute("aria-pressed", "false");
  });
  relabel(tool);
  if (waiters.length) {
    Promise.all(waiters).then(() => relabel(tool)).catch(() => { /* already gone */ });
  }
}

function disableOptions(tool) {
  const input = $(`#${tool}-pages`);
  if (input) input.disabled = true;
  $$(`#${tool}-options .rot-angle`).forEach((b) => { b.disabled = true; });
  $$(`#${tool}-options .compress-level`).forEach((b) => { b.disabled = true; });
  $$(`#${tool}-options input[name="split-mode"]`).forEach((r) => { r.disabled = true; });
  $$(`#${tool}-options input[type="password"]`).forEach((inp) => { inp.disabled = true; });
  toolState(tool).cutNodes.forEach((cut) => { cut.disabled = true; });
}

/* ------------------------------------------------------------------ */
/* single-file pdf tools: run                                          */
/* ------------------------------------------------------------------ */

function runTool(tool) {
  const def = PDF_TOOLS[tool];
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry || state.working) return;

  if (def.mode === "select") {
    if (tool === "rotate" && state.pendingDeg === null) {
      setNotice(tool, COPY.chooseAngle);
      return;
    }
    if (tool !== "rotate" && !state.sel.size) {
      setNotice(tool, def.emptyMsg);
      return;
    }
    if (tool === "delete" && state.sel.size === entry.pageCount) {
      setNotice(tool, COPY.deleteAll);
      return;
    }
  } else if (def.mode === "cuts") {
    const parts = splitPartsCount();
    if (!parts) { setNotice(tool, def.emptyMsg); return; }
  }

  state.working = true;
  clearNotice(tool);
  const progress = $(`#${tool}-progress`);
  const bar = $(".progress__bar", progress);
  bar.style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const go = $(`#${tool}-go`);
  go.disabled = true;
  go.textContent = workingLabel(tool);
  setStatus(tool, "", false);

  const form = new FormData();
  form.append("file", entry.file, entry.name);
  let parts = 0;
  let keptSnapshot = null;
  if (def.mode === "select") {
    if (tool === "rotate") form.append("degrees", String(state.pendingDeg));
    form.append("pages", canonicalRange([...state.sel].sort((a, b) => a - b), entry.pageCount));
    keptSnapshot = tool === "delete"
      ? allIndices(entry.pageCount).filter((i) => !state.sel.has(i))
      : [...state.sel].sort((a, b) => a - b);
  } else if (def.mode === "cuts") {
    parts = splitPartsCount();
    form.append("mode", splitMode());
    form.append("cuts", [...state.cutSel].sort((a, b) => a - b).join(","));
  } else if (tool === "compress") {
    form.append("level", state.level || "standard");
  } else if (tool === "lock") {
    form.append("password", $("#lock-password").value);
  } else if (tool === "unlock" && $("#unlock-password").value) {
    // No field and no key: the server asks for one with its own reply.
    form.append("password", $("#unlock-password").value);
  }

  const xhr = new XMLHttpRequest();
  xhr.open("POST", def.endpoint);
  xhr.responseType = "blob";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;             // loseServer owns the display for this one
    loseServer(tool);
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay(); // a reply at all means the server is back
    if (xhr.status >= 200 && xhr.status < 300) {
      const header = xhr.getResponseHeader("Content-Disposition") || "";
      finish(null, { blob: xhr.response, name: headerFileName(header, "result.pdf") });
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        let message = COPY.serverDown;
        try { message = JSON.parse(String(reader.result)).error || message; } catch { /* keep */ }
        finish(new Error(message));
      };
      reader.onerror = () => finish(new Error(COPY.serverDown));
      reader.readAsText(xhr.response);
    }
  };

  function finish(err, ok) {
    const status = xhr.status;
    state.working = false;
    progress.hidden = true;
    go.textContent = def.button;
    if (err) {
      if (tool === "unlock" && status === 423) {
        // The server met an encryption pdf.js didn't flag: ask for the key.
        holdLockedEntry(entry);
        return;
      }
      if (!err.network) setNotice(tool, err.message); // network loss: loseServer already spoke
      syncControls(tool);
      return;
    }
    revokeResult(tool);
    state.resultUrl = URL.createObjectURL(ok.blob);
    state.resultName = ok.name;
    const link = $(`#${tool}-download`);
    link.href = state.resultUrl;
    link.setAttribute("download", ok.name);
    link.textContent = `Download ${ok.name}`;
    crossFade(link, go);

    // Compute the summary before the strip is culled (sel gets cleared).
    const outPages = tool === "split" ? parts
      : tool === "rotate" ? (state.sel.size || entry.pageCount)
      : (keptSnapshot ? keptSnapshot.length : 0);

    if (tool === "rotate") commitRotate(state);
    if (tool === "extract" || tool === "delete") finishPageSet(tool, keptSnapshot || []);
    state.done = true;
    disableOptions(tool);

    let summary;
    if (tool === "compress") {
      summary = compressSummaryLine(xhr, entry);
    } else if (tool === "lock") {
      summary = `${fmtPages(entry.pageCount)}, ${fmtBytes(ok.blob.size)}`;
    } else if (tool === "unlock") {
      summary = unlockAfterSuccess(ok, entry);
    } else {
      summary = tool === "split"
        ? `${parts} files, ${fmtBytes(ok.blob.size)}`
        : `${fmtPages(outPages)}, ${fmtBytes(ok.blob.size)}`;
    }
    setStatus(tool, summary, true);
    syncControls(tool);
  }

  xhr.send(form);
}

/* ------------------------------------------------------------------ */
/* phase 4: compress level, passwords, unlocking, extracted text        */
/* ------------------------------------------------------------------ */

const COMPRESS_HINT = {
  standard: "Lossless. Rewrites the file without touching how it looks.",
  strong: "Rebuilds photos as smaller JPEGs. Image quality goes down a little.",
};

function compressLevelUI(level) {
  const state = toolState("compress");
  state.level = level;
  $$(".compress-level").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.level === level));
  });
  $("#compress-hint").textContent = COMPRESS_HINT[level] || COMPRESS_HINT.standard;
}

function onCompressLevelClick(btn) {
  const state = toolState("compress");
  if (state.working || state.done || state.level === btn.dataset.level) return;
  clearNotice("compress");
  compressLevelUI(btn.dataset.level);
}

/* "Saved 38%. 4.2 MB to 2.6 MB" from the server's size headers, with the
   little-gain and unchanged results saying so in plain words. */
function compressSummaryLine(xhr, entry) {
  const headerSize = (name, fallback) => {
    const value = Number(xhr.getResponseHeader(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const original = headerSize("X-Folio-Original", entry.size);
  const result = headerSize("X-Folio-Result", 0) || original;
  if (xhr.getResponseHeader("X-Folio-Unchanged") === "1") {
    return "No smaller copy came out. This file is already as small as it gets.";
  }
  const pct = Math.round((1 - result / original) * 100);
  if (pct < 5) {
    return `Saved ${pct}%. This file is mostly images, so it can't shrink much.`;
  }
  return `Saved ${pct}%. ${fmtBytes(original)} to ${fmtBytes(result)}`;
}

function lockPasswordsMatch() {
  const first = $("#lock-password").value;
  return first.length > 0 && first === $("#lock-confirm").value;
}

function syncLockHint() {
  const hint = $("#lock-hint");
  const first = $("#lock-password").value;
  const second = $("#lock-confirm").value;
  if (first && first === second) hint.textContent = "The passwords match. Locking is ready.";
  else if (first || second) hint.textContent = "The two passwords don't match yet.";
  else hint.textContent = "Type the same password twice to lock the copy.";
}

/* Show/hide toggles for password fields (Lock twice, Unlock once). */

function resetEye(btn, showing = false) {
  btn.setAttribute("aria-pressed", String(showing));
  btn.setAttribute("aria-label", showing ? "Hide password" : "Show password");
  const use = btn.querySelector("use");
  if (use) use.setAttribute("href", showing ? "#i-eye-off" : "#i-eye");
}

function wireEye(btn, input) {
  btn.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    input.focus({ preventScroll: true });
    resetEye(btn, show);
  });
}

/* A locked file in Unlock stays on the desk: one quiet locked sheet in
   the strip, the password field underneath, no error shout. */

function markLockedSheet(entry) {
  if (!entry.pagesEl) return;
  let node = entry.pageNodes[0];
  if (!node) {
    node = makePageNode(entry, 0, pageModeOf(entry.tool));
    entry.pageNodes = [node];
  }
  entry.pagesEl.replaceChildren(node.btn);
  node.sheet.classList.remove("is-loading");
  node.sheet.classList.add("is-locked");
  node.sheet.replaceChildren(svgIcon("i-lock", "strip__lockicon"));
  node.label.textContent = "Locked";
}

function holdLockedEntry(entry) {
  const state = toolState("unlock");
  state.locked = true;
  closeDoc(entry);
  entry.doc = null;
  markLockedSheet(entry);
  $("#unlock-options").hidden = false;
  const hint = $("#unlock-hint");
  hint.hidden = false;
  hint.textContent = COPY.locked;
  clearNotice("unlock");
  setStatus("unlock", "", false); // the hint below carries the ask
  syncControls("unlock");
  $("#unlock-password").focus({ preventScroll: true });
}

/* Unlock succeeded: hand the open copy over (the strip re-renders from
   it), drop the password field, and answer with the worked summary. */
function unlockAfterSuccess(ok, entry) {
  const state = toolState("unlock");
  state.locked = false;
  entry.file = ok.blob;
  entry.name = ok.name;
  entry.size = ok.blob.size;
  const row = $("#unlock-filerow");
  $(".filerow__name", row).textContent = shortName(entry.name, 44);
  $(".filerow__name", row).title = entry.name;
  $(".filerow__meta", row).textContent = fmtBytes(entry.size);
  const field = $("#unlock-password");
  field.value = "";
  field.type = "password";
  resetEye($("#unlock-eye"));
  $("#unlock-options").hidden = true;
  $("#unlock-hint").hidden = true;
  closeDoc(entry);
  entry.doc = null;
  const known = entry.pageCount;
  entry.pageCount = null;
  renderEntry(entry).then(() => {
    if (entry.pageCount && toolState("unlock").entry === entry) {
      setStatus("unlock", `${fmtPages(entry.pageCount)}, ${fmtBytes(entry.size)}`, true);
    }
  }).catch(() => { /* strip refresh is cosmetic */ });
  return known ? `${fmtPages(known)}, ${fmtBytes(entry.size)}` : fmtBytes(entry.size);
}

/* ------------------------------------------------------------------ */
/* text: a JSON run that fills the reading panel                        */
/* ------------------------------------------------------------------ */

const TEXT_PREVIEW_MAX = 50;

function nameBaseOf(name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.trim() || "document";
}

function buildTextBody(data) {
  const blocks = data.pages.map((text, i) => `Page ${i + 1}\n${text}`);
  return blocks.join("\n\n") + "\n";
}

function fillTextPanel(data) {
  const box = $("#text-box");
  const note = $("#text-note");
  note.hidden = true;
  note.textContent = "";
  const frag = document.createDocumentFragment();
  const shown = data.pages.slice(0, TEXT_PREVIEW_MAX);
  shown.forEach((text, i) => {
    const page = el("div", "textpanel__page");
    page.appendChild(el("span", "textpanel__pageno", `Page ${i + 1}`));
    page.appendChild(el("div", "textpanel__text", text || "(no text on this page)"));
    frag.appendChild(page);
  });
  box.replaceChildren(frag);
  $("#text-details").hidden = false;
  if (data.total > shown.length) {
    note.textContent = `Showing the first ${shown.length} of ${data.total} pages. The download has every page.`;
    note.hidden = false;
  }
}

function runText() {
  const tool = "text";
  const def = PDF_TOOLS[tool];
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry || state.working || state.done) return;

  state.working = true;
  clearNotice(tool);
  const progress = $(`#${tool}-progress`);
  const bar = $(".progress__bar", progress);
  bar.style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const go = $(`#${tool}-go`);
  go.disabled = true;
  go.textContent = workingLabel(tool);
  setStatus(tool, "", false);

  const form = new FormData();
  form.append("file", entry.file, entry.name);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", def.endpoint);
  xhr.responseType = "text";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer(tool);
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status < 200 || xhr.status >= 300) {
      let message = COPY.serverDown;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep */ }
      finish(new Error(message));
      return;
    }
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { /* keep null */ }
    if (!data || !Array.isArray(data.pages)) { finish(new Error(COPY.serverDown)); return; }
    finish(null, data);
  };
  xhr.send(form);

  function finish(err, data) {
    state.working = false;
    progress.hidden = true;
    go.textContent = def.button;
    if (err) {
      if (!err.network) setNotice(tool, err.message);
      syncControls(tool);
      return;
    }
    state.done = true;
    disableOptions(tool);
    if (data.scanned) {
      setNotice(tool, COPY.scanned);
      setStatus(tool, "", false);
      syncControls(tool);
      return;
    }
    state.textData = data;
    fillTextPanel(data);
    revokeResult(tool);
    state.resultUrl = URL.createObjectURL(
      new Blob([buildTextBody(data)], { type: "text/plain;charset=utf-8" }));
    state.resultName = `${nameBaseOf(entry.name)}-text.txt`;
    const link = $(`#${tool}-download`);
    link.href = state.resultUrl;
    link.setAttribute("download", state.resultName);
    $("#text-copy").hidden = false;
    crossFade(link, go);
    setStatus(tool, `${fmtPages(data.total)} of text`, true);
    syncControls(tool);
  }
}

async function onTextCopy() {
  const data = toolState("text").textData;
  if (!data) return;
  const body = buildTextBody(data);
  let copied = false;
  try {
    await navigator.clipboard.writeText(body);
    copied = true;
  } catch { /* file pickers and headless runs fall through here */ }
  if (!copied) {
    const ta = document.createElement("textarea");
    ta.value = body;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { copied = document.execCommand("copy"); } catch { /* stay quiet */ }
    ta.remove();
  }
  const btn = $("#text-copy");
  if (!copied) return;
  btn.textContent = "Copied";
  window.setTimeout(() => { btn.textContent = "Copy"; }, 1200);
}

/* ------------------------------------------------------------------ */
/* watermark                                                            */
/* ------------------------------------------------------------------ */

/* The dropdowns offer the same families the server carries
   (pymupdf_ops.FAMILIES): the base-14 PDF fonts plus the bundled
   DejaVu faces. The live strip preview draws with the same names. */
const FONT_FAMILIES = {
  helvetica: "Helvetica", times: "Times", courier: "Courier",
  dejavusans: "DejaVu Sans", dejavuserif: "DejaVu Serif",
  dejavumono: "DejaVu Sans Mono",
};

const WM_CSS_FONTS = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  dejavusans: "'DejaVu Sans', sans-serif",
  dejavuserif: "'DejaVu Serif', serif",
  dejavumono: "'DejaVu Sans Mono', monospace",
};

function fillFontSelects() {
  for (const sel of [$("#watermark-font"), $("#edit-font")]) {
    if (!sel) continue;
    sel.replaceChildren(...Object.entries(FONT_FAMILIES).map(([id, label]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      return opt;
    }));
  }
}

const wm = {
  position: "centre",   // pressed choice, like the rotate angles
  imageFile: null,      // the chosen stamp image
  imageUrl: null,       // object URL for the live preview
  imgW: 0, imgH: 0,     // natural size, once loaded
};

function wmKind() {
  return $('input[name="watermark-kind"][value="image"]').checked ? "image" : "text";
}

function wmSwapKind() {
  const image = wmKind() === "image";
  $("#watermark-text-field").hidden = image;
  $("#watermark-font-field").hidden = image;
  $("#watermark-image-field").hidden = !image;
  $("#watermark-scale-field").hidden = !image;
}

function watermarkReady() {
  const state = toolState("watermark");
  if (!state.entry || !state.entry.pageCount) return false;
  if (wmKind() === "image") return Boolean(wm.imageFile);
  return $("#watermark-text").value.trim().length > 0;
}

function readWmOptions() {
  return {
    kind: wmKind(),
    text: $("#watermark-text").value,
    font: $("#watermark-font").value,
    size: Number($("#watermark-size").value) || 48,
    colour: $("#watermark-colour").value,
    opacity: Number($("#watermark-opacity").value),
    angle: Number($("#watermark-angle").value) || 0,
    position: wm.position,
    margin: Number($("#watermark-margin").value) || 0,
    scale: Number($("#watermark-scale").value) || 30,
    pages: $("#watermark-pages").value,
    behind: $("#watermark-behind").checked,
  };
}

/* Live preview on the strip: the same geometry the server stamps,
   drawn as absolutely positioned nodes over each rendered sheet. It is
   a close approximation; the server produces the real result. */
function paintWmPreview(entry, i, canvas) {
  const node = entry.pageNodes[i];
  if (!node || !node.sheet || !canvas) return;
  const old = node.sheet.querySelector(".wm-preview");
  if (old) old.remove();
  const opts = readWmOptions();
  if (opts.pages) {
    const range = parsePageRange(opts.pages, entry.pageCount);
    if (!range.error && !range.indices.includes(i)) return;
  }
  const W = node.vpW || (canvas.width / 2);
  const H = node.vpH || (canvas.height / (canvas.width / W));
  const s = 110 / W;                      // CSS px per point
  const layer = el("div", "wm-preview");
  layer.setAttribute("aria-hidden", "true");
  layer.style.opacity = String(opts.opacity / 100);
  if (opts.behind) layer.style.opacity = String(Math.min(0.9, opts.opacity / 100));

  const m = Math.min(opts.margin, W / 4, H / 4);

  if (opts.kind === "image") {
    if (!wm.imageUrl || !wm.imgW) return;
    const base = Math.min(W, H) * (opts.scale / 100);
    const w = base;
    const h = base * wm.imgH / wm.imgW;
    let rects;
    if (opts.position === "centre") {
      rects = [[(W - w) / 2, (H - h) / 2]];
    } else if (opts.position === "corners") {
      rects = [[m, m], [W - m - w, m], [m, H - m - h], [W - m - w, H - m - h]];
    } else {
      const stepX = Math.max(w + 2 * m, w + 12);
      const stepY = Math.max(h + 2 * m, h + 12);
      rects = [];
      for (let y = m; y < H - h; y += stepY) {
        for (let x = m; x < W - w; x += stepX) rects.push([x, y]);
      }
      if (!rects.length) rects = [[m, m]];
    }
    for (const [x, y] of rects) {
      const img = document.createElement("img");
      img.src = wm.imageUrl;
      img.alt = "";
      img.className = "wm-preview__item";
      img.style.left = `${(x + w / 2) * s}px`;
      img.style.top = `${(y + h / 2) * s}px`;
      img.style.width = `${w * s}px`;
      img.style.transform = `translate(-50%, -50%) rotate(${opts.angle}deg)`;
      layer.appendChild(img);
    }
  } else {
    if (!opts.text.trim()) return;
    const font = `${opts.size}px ${WM_CSS_FONTS[opts.font] || WM_CSS_FONTS.helvetica}`;
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = font;
    const w = ctx.measureText(opts.text).width;   // ~ points, like the server
    const h = opts.size * 1.2;
    let spots;
    if (opts.position === "centre") {
      spots = [[(W - w) / 2, (H - h) / 2]];
    } else if (opts.position === "corners") {
      spots = [[m, m], [W - m - w, m], [m, H - m - h], [W - m - w, H - m - h]];
    } else {
      const stepX = Math.max(w + 2 * m, w + 12);
      const stepY = Math.max(h * 3, h + m + 12);
      spots = [];
      for (let y = m; y < H - h; y += stepY) {
        for (let x = m; x < W - w; x += stepX) spots.push([x, y]);
      }
      if (!spots.length) spots = [[m, m]];
    }
    for (const [x, y] of spots) {
      const stamp = el("div", "wm-preview__item wm-preview__text");
      stamp.textContent = opts.text;
      stamp.style.left = `${(x + w / 2) * s}px`;
      stamp.style.top = `${(y + h / 2) * s}px`;
      stamp.style.font = font;
      stamp.style.color = opts.colour;
      stamp.style.transform = `translate(-50%, -50%) rotate(${opts.angle}deg)`;
      layer.appendChild(stamp);
    }
  }
  node.sheet.appendChild(layer);
}

function repaintWmPreviews() {
  const entry = toolState("watermark").entry;
  if (!entry) return;
  entry.pageNodes.forEach((node, i) => {
    if (node.sheet && node.sheet.querySelector("canvas")) {
      paintWmPreview(entry, i, node.sheet.querySelector("canvas"));
    }
  });
}

function resetWatermarkFields() {
  $("#watermark-text").value = "";
  $("#watermark-font").value = "helvetica";
  $("#watermark-size").value = "48";
  $("#watermark-colour").value = "#9aa0a6";
  $("#watermark-opacity").value = "20";
  $("#watermark-opacity-hint").textContent = "20%";
  $("#watermark-angle").value = "45";
  $("#watermark-margin").value = "36";
  $("#watermark-scale").value = "30";
  $("#watermark-pages").value = "";
  $("#watermark-behind").checked = false;
  const textKind = $('input[name="watermark-kind"][value="text"]');
  if (textKind) textKind.checked = true;
  wm.position = "centre";
  $$(".wm-position").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.position === "centre"));
  });
  if (wm.imageUrl) URL.revokeObjectURL(wm.imageUrl);
  wm.imageFile = null;
  wm.imageUrl = null;
  wm.imgW = 0;
  wm.imgH = 0;
  const input = $("#watermark-image");
  if (input) input.value = "";
  wmSwapKind();
}

/* The watermark POST: like runTool, plus the form fields and the
   server's notes header (a fallback font had to step in, say). */
function runWatermark() {
  const tool = "watermark";
  const def = PDF_TOOLS[tool];
  const state = toolState(tool);
  const entry = state.entry;
  if (!entry || state.working || state.done) return;
  const opts = readWmOptions();

  state.working = true;
  clearNotice(tool);
  const progress = $(`#${tool}-progress`);
  const bar = $(".progress__bar", progress);
  bar.style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const go = $(`#${tool}-go`);
  go.disabled = true;
  go.textContent = workingLabel(tool);
  setStatus(tool, "", false);

  const form = new FormData();
  form.append("file", entry.file, entry.name);
  if (opts.kind === "image") {
    form.append("image", wm.imageFile, wm.imageFile.name);
  } else {
    form.append("text", opts.text.trim());
    form.append("font", opts.font);
  }
  form.append("size", String(opts.size));
  form.append("colour", opts.colour);
  form.append("opacity", String(opts.opacity));
  form.append("angle", String(opts.angle));
  form.append("position", opts.position);
  form.append("margin", String(opts.margin));
  if (opts.kind === "image") form.append("scale", String(opts.scale));
  form.append("pages", opts.pages);
  if (opts.behind) form.append("behind", "1");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", def.endpoint);
  xhr.responseType = "blob";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer(tool);
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status >= 200 && xhr.status < 300) {
      const header = xhr.getResponseHeader("Content-Disposition") || "";
      finish(null, {
        blob: xhr.response,
        name: headerFileName(header, `${nameBaseOf(entry.name)}-watermarked.pdf`),
      });
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        let message = COPY.serverDown;
        try { message = JSON.parse(String(reader.result)).error || message; } catch { /* keep */ }
        finish(new Error(message));
      };
      reader.onerror = () => finish(new Error(COPY.serverDown));
      reader.readAsText(xhr.response);
    }
  };

  function finish(err, ok) {
    state.working = false;
    progress.hidden = true;
    go.textContent = def.button;
    if (err) {
      if (!err.network) setNotice(tool, err.message);
      syncControls(tool);
      return;
    }
    revokeResult(tool);
    state.resultUrl = URL.createObjectURL(ok.blob);
    state.resultName = ok.name;
    const link = $(`#${tool}-download`);
    link.href = state.resultUrl;
    link.setAttribute("download", ok.name);
    link.textContent = `Download ${ok.name}`;
    crossFade(link, go);
    state.done = true;
    disableOptions(tool);
    setStatus(tool, `${fmtPages(entry.pageCount)}, ${fmtBytes(ok.blob.size)}`, true);
    const notesHeader = xhr.getResponseHeader("X-Folio-Notes");
    if (notesHeader) {
      try {
        const notes = JSON.parse(decodeURIComponent(notesHeader));
        if (Array.isArray(notes) && notes.length) setNotice(tool, notes.join(" "));
      } catch { /* a bad header is not worth a crash */ }
    }
    syncControls(tool);
  }

  xhr.send(form);
}

/* ------------------------------------------------------------------ */
/* text editing (Text > Edit)                                           */
/* ------------------------------------------------------------------ */

/* The edit tab keeps its own state: it shares nothing with the Read
   tab's extraction except the panel machinery. Nothing is written into
   the file until "Save PDF" — edits sit in a queue until then. */
const edit = {
  entry: null, data: null, password: "",
  page: 0, seq: 0, scale: 1,
  sel: null,            // {kind:"span",page,id} | {kind:"item",itemId} | {kind:"draft"}
  draft: null,          // an "Add text" box placed but not queued yet
  queue: [], nextId: 1,
  placing: false,
  working: false, resultUrl: null, resultName: null, done: false,
};

function resetEditState() {
  if (edit.resultUrl) URL.revokeObjectURL(edit.resultUrl);
  Object.assign(edit, {
    entry: null, data: null, password: "", page: 0, scale: 1,
    sel: null, draft: null, queue: [], placing: false,
    working: false, resultUrl: null, resultName: null, done: false,
    seq: edit.seq + 1,
  });
  edit.nextId = 1;
  const stage = $("#edit-stage");
  if (stage) stage.hidden = true;
  $("#edit-pagehint").hidden = true;
  $("#edit-password-options").hidden = true;
  $("#edit-panel").hidden = true;
  $("#edit-queue-panel").hidden = true;
  $("#edit-download").hidden = true;
  $("#edit-save").hidden = false;
  $("#edit-password").value = "";
  const canvas = $("#edit-canvas");
  canvas.width = 0;
  canvas.height = 0;
  $("#edit-overlay").replaceChildren();
  $("#edit-queue").replaceChildren();
  clearNotice("edit");
  setStatus("edit", "", false);
}

function editStart(entry) {
  edit.entry = entry;
  setStatus("edit", "Reading file...", false);
  fetchSpans("");
}

function fetchSpans(password) {
  const state = toolState("edit");
  const entry = state.entry;
  if (!entry || edit.working) return;
  edit.working = true;
  const progress = $("#edit-progress");
  $(".progress__bar", progress).style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");

  const form = new FormData();
  form.append("file", entry.file, entry.name);
  if (password) form.append("password", password);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/text-edit/spans");
  xhr.responseType = "text";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer("edit");
    finish(err, 0);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow), 0);
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status >= 200 && xhr.status < 300) {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* keep null */ }
      if (!data || !Array.isArray(data.pages)) { finish(new Error(COPY.serverDown), 0); return; }
      finish(null, 0, data);
    } else {
      let message = COPY.serverDown;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep */ }
      finish(new Error(message), xhr.status);
    }
  };
  xhr.send(form);

  function finish(err, status, data) {
    edit.working = false;
    progress.hidden = true;
    if (err) {
      if (status === 423) {
        // The password line is the server's own; the field appears now.
        $("#edit-password-options").hidden = false;
        setStatus("edit", "", false);
        $("#edit-password").focus();
        return;
      }
      if (!err.network) setNotice("edit", err.message);
      setStatus("edit", "", false);
      return;
    }
    edit.data = data;
    edit.password = password || "";
    openEditDoc();
  }
}

async function openEditDoc() {
  const state = toolState("edit");
  const entry = state.entry;
  if (!entry) return;
  setStatus("edit", "Opening the pages...", false);
  try {
    const data = await ensureDocData(entry.file);
    const doc = await pdfjsLib.getDocument({
      data: data.slice(0),
      isEvalSupported: false,
      password: edit.password || undefined,
    }).promise;
    if (state.entry !== entry) return;
    entry.doc = doc;
    entry.pageCount = doc.numPages;
    if (entry.captionMeta) entry.captionMeta.textContent = `${fmtPages(doc.numPages)}, ${fmtBytes(entry.size)}`;
    placeCanvases(entry);
    $("#edit-stage").hidden = false;
    showEditPage(0);
    setStatus("edit", `${fmtPages(doc.numPages)} to edit`, true);
    syncEditControls();
  } catch {
    failFile(entry, "edit", COPY.corrupt);
  }
}

async function showEditPage(i) {
  const entry = edit.entry;
  if (!entry || !entry.doc || !edit.data) return;
  if (i < 0 || i >= entry.pageCount) return;
  edit.page = i;
  edit.seq += 1;
  const seq = edit.seq;
  entry.pageNodes.forEach((node, k) => {
    node.btn.classList.toggle("is-selected", k === i);
  });
  let page;
  try {
    page = await entry.doc.getPage(i + 1);
  } catch {
    return;
  }
  if (edit.seq !== seq) return;
  const stage = $("#edit-stage");
  const target = Math.max(320, stage.clientWidth - 24);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = target / vp1.width;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: scale * dpr });
  const canvas = $("#edit-canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  try {
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  } catch {
    return;
  }
  if (edit.seq !== seq) return;
  canvas.style.width = `${Math.round(scale * vp1.width)}px`;
  canvas.style.height = `${Math.round(scale * vp1.height)}px`;
  edit.scale = scale;
  buildOverlay();
  paintPageHint();
}

/* The page hint speaks before anyone selects: rotated text on this
   page means edits will land flat. */
function paintPageHint() {
  const info = edit.data && edit.data.pages[edit.page];
  const hint = $("#edit-pagehint");
  if (info && info.rotated) {
    hint.textContent = "This page has text set at an angle. You can still select it, but new text is written flat.";
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

/* One absolutely positioned button per span, in page coordinates:
   real <button>s, so Tab walks the lines and Enter selects. */
function buildOverlay() {
  const overlay = $("#edit-overlay");
  overlay.replaceChildren();
  if (!edit.data) return;
  const scale = edit.scale;
  const pageInfo = edit.data.pages[edit.page];
  const queued = edit.queue.filter((q) => !q.undone && q.page === edit.page);
  for (const span of pageInfo.spans) {
    const btn = el("button", "edit-span");
    btn.type = "button";
    const [x0, y0, x1, y1] = span.bbox;
    btn.style.left = `${x0 * scale}px`;
    btn.style.top = `${y0 * scale}px`;
    btn.style.width = `${(x1 - x0) * scale}px`;
    btn.style.height = `${(y1 - y0) * scale}px`;
    btn.dataset.id = String(span.id);
    btn.title = span.text;
    btn.setAttribute("aria-label", `Text: ${shortName(span.text, 60)}`);
    paintSpanState(btn, span.id, queued);
    btn.addEventListener("click", () => selectSpan(edit.page, span.id));
    overlay.appendChild(btn);
  }
  for (const q of queued) {
    if (q.kind !== "add") continue;
    overlay.appendChild(placeBox(q, scale, "is-new"));
  }
  if (edit.draft && edit.draft.page === edit.page) {
    overlay.appendChild(placeBox({ bbox: edit.draft.bbox }, scale, "is-new is-draft"));
  }
}

function placeBox(q, scale, cls) {
  const box = el("div", `edit-span ${cls}`);
  const [x0, y0, x1, y1] = q.bbox;
  box.style.left = `${x0 * scale}px`;
  box.style.top = `${y0 * scale}px`;
  box.style.width = `${(x1 - x0) * scale}px`;
  box.style.height = `${(y1 - y0) * scale}px`;
  box.setAttribute("aria-hidden", "true");
  return box;
}

function paintSpanState(btn, spanId, queued) {
  const hit = (kind) => queued.some((q) => q.kind === kind && q.spanId === spanId);
  btn.classList.toggle("is-deleted", hit("delete"));
  btn.classList.toggle("is-edited", hit("change"));
  const sel = edit.sel;
  const selected = Boolean(sel && (
    (sel.kind === "span" && sel.page === edit.page && sel.id === spanId)
    || (sel.kind === "item" && sel.spanId === spanId && sel.page === edit.page)));
  btn.classList.toggle("is-selected", selected);
}

function paintQueueState() {
  const queued = edit.queue.filter((q) => !q.undone && q.page === edit.page);
  $$("#edit-overlay .edit-span[data-id]").forEach((btn) => {
    paintSpanState(btn, Number(btn.dataset.id), queued);
  });
}

function panelValues() {
  return {
    text: $("#edit-text").value,
    family: $("#edit-font").value,
    size: Number($("#edit-size").value) || 12,
    bold: $("#edit-bold").getAttribute("aria-pressed") === "true",
    italic: $("#edit-italic").getAttribute("aria-pressed") === "true",
    colour: $("#edit-colour").value,
  };
}

function fillEditPanel(span) {
  const match = edit.data.fonts[span.font]
    || { family: "helvetica", bold: false, italic: false, substituted: true };
  $("#edit-panel-title").textContent = "Selected text";
  $("#edit-text").value = span.text;
  $("#edit-font").value = match.family;
  $("#edit-size").value = String(span.size);
  $("#edit-bold").setAttribute("aria-pressed", String(Boolean(match.bold)));
  $("#edit-italic").setAttribute("aria-pressed", String(Boolean(match.italic)));
  $("#edit-colour").value = span.colour;
  const note = $("#edit-fontnote");
  if (match.substituted) {
    note.textContent = `"${span.font}" is not on this machine, so edits are written in ${FONT_FAMILIES[match.family]}.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  $("#edit-apply").disabled = false;
  $("#edit-del").disabled = false;
  $("#edit-panel").hidden = false;
}

function selectSpan(page, id) {
  const span = edit.data.pages[page].spans[id];
  if (!span) return;
  edit.placing = false;
  $("#edit-add").setAttribute("aria-pressed", "false");
  edit.sel = { kind: "span", page, id };
  fillEditPanel(span);
  paintQueueState();
  $("#edit-text").focus({ preventScroll: true });
}

function selectItem(itemId) {
  const q = edit.queue.find((x) => x.id === itemId);
  if (!q) return;
  edit.placing = false;
  $("#edit-add").setAttribute("aria-pressed", "false");
  edit.sel = { kind: "item", itemId: q.id, spanId: q.spanId, page: q.page };
  $("#edit-panel-title").textContent = q.kind === "add" ? "Added text" : `Edit on page ${q.page + 1}`;
  $("#edit-text").value = q.text;
  $("#edit-font").value = q.family;
  $("#edit-size").value = String(q.size);
  $("#edit-bold").setAttribute("aria-pressed", String(Boolean(q.bold)));
  $("#edit-italic").setAttribute("aria-pressed", String(Boolean(q.italic)));
  $("#edit-colour").value = q.colour;
  $("#edit-fontnote").hidden = true;
  $("#edit-apply").disabled = false;
  $("#edit-del").disabled = true;
  $("#edit-panel").hidden = false;
  paintQueueState();
}

function fillDraftPanel() {
  $("#edit-panel-title").textContent = "New text";
  $("#edit-text").value = "";
  $("#edit-font").value = "helvetica";
  $("#edit-size").value = "12";
  $("#edit-bold").setAttribute("aria-pressed", "false");
  $("#edit-italic").setAttribute("aria-pressed", "false");
  $("#edit-colour").value = "#202124";
  $("#edit-fontnote").hidden = true;
  $("#edit-apply").disabled = false;
  $("#edit-del").disabled = true;
  $("#edit-panel").hidden = false;
}

/* Apply: a span edit replaces any earlier edit on the same span; an
   item edit updates that item in place; a draft becomes a queued item. */
function applyEdit() {
  const values = panelValues();
  if (!values.text.trim()) {
    setNotice("edit", "Type the new text before saving.");
    $("#edit-text").focus();
    return;
  }
  clearNotice("edit");
  const sel = edit.sel;
  if (!sel) return;
  if (sel.kind === "draft" && edit.draft) {
    const q = {
      id: edit.nextId++, kind: "add", page: edit.draft.page, spanId: null,
      bbox: edit.draft.bbox, orig: "", undone: false, ...values,
    };
    edit.queue.push(q);
    edit.draft = null;
    buildOverlay();
    renderQueue();
    selectItem(q.id);
  } else if (sel.kind === "span") {
    const span = edit.data.pages[sel.page].spans[sel.id];
    const existing = edit.queue.find((q) => !q.undone && q.page === sel.page
      && q.spanId === sel.id);
    const q = existing || {
      id: edit.nextId++, kind: "change", page: sel.page, spanId: sel.id,
      bbox: span.bbox, orig: span.text, undone: false,
    };
    Object.assign(q, values);
    q.kind = existing ? existing.kind : "change";
    if (!existing) edit.queue.push(q);
    renderQueue();
    paintQueueState();
  } else if (sel.kind === "item") {
    const q = edit.queue.find((x) => x.id === sel.itemId);
    if (!q) return;
    Object.assign(q, values);
    q.undone = false;
    renderQueue();
    paintQueueState();
  }
}

function deleteSel() {
  const sel = edit.sel;
  if (!sel || sel.kind !== "span") return;
  const span = edit.data.pages[sel.page].spans[sel.id];
  const existing = edit.queue.find((q) => !q.undone && q.page === sel.page
    && q.spanId === sel.id);
  const q = existing || {
    id: edit.nextId++, kind: "delete", page: sel.page, spanId: sel.id,
    bbox: span.bbox, orig: span.text, undone: false,
  };
  Object.assign(q, {
    kind: "delete", text: "",
    family: $("#edit-font").value, bold: false, italic: false,
    size: Number($("#edit-size").value) || 12, colour: $("#edit-colour").value,
  });
  if (!existing) edit.queue.push(q);
  renderQueue();
  paintQueueState();
}

function togglePlacing() {
  edit.placing = !edit.placing;
  $("#edit-add").setAttribute("aria-pressed", String(edit.placing));
  $("#edit-stage").classList.toggle("is-placing", edit.placing);
  setStatus("edit", edit.placing ? "Click the page where the new text goes." : "", false);
}

function renderQueue() {
  const list = $("#edit-queue");
  list.replaceChildren();
  for (const q of edit.queue) {
    const li = el("li", "edit-queue__item");
    li.classList.toggle("is-undone", Boolean(q.undone));
    const label = el("span", "edit-queue__text");
    const pageNo = q.page + 1;
    if (q.kind === "delete") label.textContent = `Page ${pageNo}: delete "${shortName(q.orig, 40)}"`;
    else if (q.kind === "add") label.textContent = `Page ${pageNo}: add "${shortName(q.text, 40) || "…"}"`;
    else label.textContent = `Page ${pageNo}: "${shortName(q.orig, 30)}" becomes "${shortName(q.text, 30)}"`;
    li.appendChild(label);
    const acts = el("span", "edit-queue__acts");
    acts.appendChild(queueBtn("undo", q, "Undo this edit", "i-undo"));
    acts.appendChild(queueBtn("redo", q, "Redo this edit", "i-redo"));
    acts.appendChild(queueBtn("revert", q, "Revert this edit", "i-trash"));
    li.appendChild(acts);
    li.addEventListener("click", () => selectItem(q.id));
    list.appendChild(li);
  }
  $("#edit-queue-panel").hidden = edit.queue.length === 0;
  syncEditControls();
}

function queueBtn(act, q, label, icon) {
  const b = el("button", "iconbtn edit-queue__btn");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.appendChild(svgIcon(icon));
  b.disabled = act === "undo" ? q.undone : act === "redo" ? !q.undone : false;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (act === "undo") q.undone = true;
    else if (act === "redo") q.undone = false;
    else {
      edit.queue = edit.queue.filter((x) => x !== q);
      if (edit.sel && edit.sel.kind === "item" && edit.sel.itemId === q.id) {
        edit.sel = null;
        $("#edit-panel").hidden = true;
      }
    }
    buildOverlay();
    renderQueue();
  });
  return b;
}

function syncEditControls() {
  const state = toolState("edit");
  const entry = state.entry;
  const has = Boolean(edit.resultUrl);
  const items = edit.queue.filter((q) => !q.undone);
  const save = $("#edit-save");
  save.hidden = has;
  save.disabled = !(entry && items.length && !edit.working && !edit.done);
  $("#edit-download").hidden = !has;
  $("#edit-reset").hidden = !has;
}

function saveEdits() {
  const state = toolState("edit");
  const entry = state.entry;
  if (!entry || edit.working || edit.done) return;
  const items = edit.queue.filter((q) => !q.undone);
  if (!items.length) { setNotice("edit", "Queue an edit before saving."); return; }
  const empty = items.find((q) => q.kind !== "delete" && !q.text.trim());
  if (empty) { setNotice("edit", "Type the new text before saving."); return; }

  edit.working = true;
  clearNotice("edit");
  const progress = $("#edit-progress");
  $(".progress__bar", progress).style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const save = $("#edit-save");
  save.disabled = true;
  save.textContent = "Saving...";
  setStatus("edit", "", false);

  const form = new FormData();
  form.append("file", entry.file, entry.name);
  form.append("edits", JSON.stringify(items.map((q) => ({
    kind: q.kind, page: q.page, bbox: q.bbox, text: q.text, orig: q.orig,
    family: q.family, bold: q.bold, italic: q.italic,
    size: q.size, colour: q.colour,
  }))));
  if (edit.password) form.append("password", edit.password);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/text-edit/apply");
  xhr.responseType = "blob";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer("edit");
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status >= 200 && xhr.status < 300) {
      const header = xhr.getResponseHeader("Content-Disposition") || "";
      finish(null, {
        blob: xhr.response,
        name: headerFileName(header, `${nameBaseOf(entry.name)}-edited.pdf`),
      });
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        let message = COPY.serverDown;
        try { message = JSON.parse(String(reader.result)).error || message; } catch { /* keep */ }
        finish(new Error(message));
      };
      reader.onerror = () => finish(new Error(COPY.serverDown));
      reader.readAsText(xhr.response);
    }
  };

  function finish(err, ok) {
    edit.working = false;
    progress.hidden = true;
    save.textContent = "Save PDF";
    if (err) {
      if (!err.network) setNotice("edit", err.message);
      syncEditControls();
      return;
    }
    if (edit.resultUrl) URL.revokeObjectURL(edit.resultUrl);
    edit.resultUrl = URL.createObjectURL(ok.blob);
    edit.resultName = ok.name;
    const link = $("#edit-download");
    link.href = edit.resultUrl;
    link.setAttribute("download", ok.name);
    link.textContent = `Download ${ok.name}`;
    crossFade(link, save);
    edit.done = true;
    const notesHeader = xhr.getResponseHeader("X-Folio-Notes");
    if (notesHeader) {
      try {
        const notes = JSON.parse(decodeURIComponent(notesHeader));
        if (Array.isArray(notes) && notes.length) setNotice("edit", notes.join(" "));
      } catch { /* a bad header is not worth a crash */ }
    }
    setStatus("edit", `${fmtPages(entry.pageCount)}, ${fmtBytes(ok.blob.size)}`, true);
    syncEditControls();
  }

  xhr.send(form);
}

/* ------------------------------------------------------------------ */
/* merge tool                                                          */
/* ------------------------------------------------------------------ */

function mergeStatusText() {
  const files = merge.files.filter((entry) => !entry.dead);
  const count = files.length;
  if (!count) return "";
  const known = files.every((entry) => entry.pageCount !== null);
  const pages = files.reduce((sum, entry) => sum + (entry.pageCount || 0), 0);
  const size = files.reduce((sum, entry) => sum + entry.size, 0);
  const parts = [`${count.toLocaleString("en")} ${count === 1 ? "file" : "files"}`];
  if (known) parts.push(fmtPages(pages));
  const tail = fmtBytes(size);
  if (count === 1) return `${parts.join(", ")}, ${tail} — choose another PDF to merge.`;
  return `${parts.join(", ")}, ${tail}`;
}

function mergeStatusDirty() {
  if (!merge.working && !merge.resultUrl) setStatus("merge", mergeStatusText(), false);
  syncMergeControls();
}

function syncMergeControls() {
  const go = $("#merge-go");
  const hasResult = Boolean(merge.resultUrl);
  go.hidden = hasResult;
  $("#merge-download").hidden = !hasResult;
  $("#merge-reset").hidden = !hasResult;
  go.disabled = !hasResult && (merge.files.length < 2 || merge.working);
  $("#merge-zone").classList.toggle("dropzone--compact", merge.files.length > 0 && !hasResult);
}

function mergeAddFile(file) {
  const entry = makeEntry(file, "merge");
  merge.files.push(entry);
  buildGroup(entry, { alone: false, caption: true });
  skeletonInto(entry);
  stripLine("merge").appendChild(entry.group);
  clearNotice("merge");
  clearMergeResult();
  mergeStatusDirty();
  renderEntry(entry);
}

async function showMergeResult(blob, name) {
  merge.resultUrl = URL.createObjectURL(blob);
  merge.resultName = name;
  const link = $("#merge-download");
  link.href = merge.resultUrl;
  link.setAttribute("download", name);
  link.textContent = `Download ${name}`;
  crossFade(link, $("#merge-go"));
  syncMergeControls();
  let summary = `${COPY.merged} ${fmtBytes(blob.size)}`;
  try {
    const buf = await blob.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
    summary = `${COPY.merged} ${fmtPages(doc.numPages)}, ${fmtBytes(blob.size)}`;
  } catch { /* size-only summary stands */ }
  setStatus("merge", summary, true);
}

function clearMergeResult() {
  if (merge.resultUrl) URL.revokeObjectURL(merge.resultUrl);
  merge.resultUrl = null;
  merge.resultName = null;
  syncMergeControls();
}

function mergeRun() {
  if (merge.working) return;
  if (merge.files.length < 2) { setNotice("merge", COPY.chooseTwo); return; }
  merge.working = true;
  clearNotice("merge");
  const progress = $("#merge-progress");
  const bar = $(".progress__bar", progress);
  bar.style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const go = $("#merge-go");
  go.disabled = true;
  go.dataset.label = COPY.startMerge;
  setStatus("merge", "", false);
  go.textContent = `Merging ${merge.files.length} files...`;

  const form = new FormData();
  merge.files.forEach((entry) => form.append("files", entry.file, entry.name));

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/merge");
  xhr.responseType = "blob";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer("merge");
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status >= 200 && xhr.status < 300) {
      const header = xhr.getResponseHeader("Content-Disposition") || "";
      finish(null, { blob: xhr.response, name: headerFileName(header, "merged.pdf") });
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        let message = COPY.serverDown;
        try { message = JSON.parse(String(reader.result)).error || message; } catch { /* keep */ }
        finish(new Error(message));
      };
      reader.onerror = () => finish(new Error(COPY.serverDown));
      reader.readAsText(xhr.response);
    }
  };

  function finish(err, ok) {
    merge.working = false;
    progress.hidden = true;
    go.textContent = COPY.startMerge;
    if (err) {
      if (!err.network) setNotice("merge", err.message);
      syncMergeControls();
    } else {
      showMergeResult(ok.blob, ok.name);
    }
  }

  xhr.send(form);
}

/* ---- reorder + keyboard (merge and images to pdf) ---- */

function flipGroups(nodes, before) {
  if (reduceMotion() || !Element.prototype.animate) return;
  nodes.forEach((node) => {
    const dx = (before.get(node) || 0) - node.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) {
      node.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
        { duration: 180, easing: "ease-out" },
      );
    }
  });
}

function orderMergeAfter(entryId, targetIdx) {
  const from = merge.files.findIndex((entry) => String(entry.id) === String(entryId));
  if (from < 0) return;
  let to = targetIdx;
  if (from < to) to -= 1;
  to = Math.max(0, Math.min(merge.files.length - 1, to));
  if (to === from) return;

  const groups = merge.files.map((entry) => entry.group);
  const before = new Map(groups.map((group) => [group, group.getBoundingClientRect().left]));
  merge.files.splice(to, 0, merge.files.splice(from, 1)[0]);
  const line = stripLine("merge");
  merge.files.forEach((entry) => line.appendChild(entry.group));
  flipGroups(groups.filter((group) => line.contains(group)), before);

  clearMergeResult();
  relabel("merge");
  retab("merge");
  mergeStatusDirty();
}

function moveFileBy(entry, dir) {
  const idx = merge.files.indexOf(entry);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= merge.files.length) return;
  const pageIdx = entry.pageNodes.findIndex((node) => node.btn === document.activeElement);
  orderMergeAfter(entry.id, dir < 0 ? target : target + 1);
  const moved = merge.files[merge.files.indexOf(entry)];
  const node = moved.pageNodes[
    Math.max(0, Math.min(moved.pageNodes.length - 1, pageIdx < 0 ? 0 : pageIdx))];
  if (node) node.btn.focus();
}

function orderConvertAfter(entryId, targetIdx) {
  const from = convert.files.findIndex((entry) => String(entry.id) === String(entryId));
  if (from < 0) return;
  let to = targetIdx;
  if (from < to) to -= 1;
  to = Math.max(0, Math.min(convert.files.length - 1, to));
  if (to === from) return;

  const groups = convert.files.map((entry) => entry.group);
  const before = new Map(groups.map((group) => [group, group.getBoundingClientRect().left]));
  convert.files.splice(to, 0, convert.files.splice(from, 1)[0]);
  const line = stripLine("to-pdf");
  convert.files.forEach((entry) => line.appendChild(entry.group));
  flipGroups(groups.filter((group) => line.contains(group)), before);

  clearConvertResult();
  relabel("to-pdf");
  retab("to-pdf");
  convertStatusDirty();
}

function moveConvertBy(entry, dir) {
  const idx = convert.files.indexOf(entry);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= convert.files.length) return;
  orderConvertAfter(entry.id, dir < 0 ? target : target + 1);
  const moved = convert.files[convert.files.indexOf(entry)];
  const node = moved.pageNodes[Math.max(0, Math.min(moved.pageNodes.length - 1, 0))];
  if (node) node.btn.focus();
}

function onSheetKey(ev) {
  const btn = ev.currentTarget;
  const stripEl = btn.closest(".strip");
  if (!stripEl) return;
  const tool = stripEl.id.replace(/-strip$/, "");
  const entry = toolEntries(tool).find(
    (e) => e.pageNodes && e.pageNodes.some((n) => n.btn === btn));
  if (!entry) return;

  if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
    ev.preventDefault();
    if (tool === "merge") moveFileBy(entry, ev.key === "ArrowLeft" ? -1 : 1);
    else if (tool === "to-pdf") moveConvertBy(entry, ev.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    const nodes = pageNodesFlat(tool);
    const i = nodes.indexOf(btn);
    const next = nodes[i + (ev.key === "ArrowLeft" ? -1 : 1)];
    if (next) { rovingPos = nodes.indexOf(next); retab(tool); next.focus(); }
    return;
  }
  if (ev.key === "Home" || ev.key === "End") {
    ev.preventDefault();
    const nodes = pageNodesFlat(tool);
    const next = ev.key === "Home" ? nodes[0] : nodes[nodes.length - 1];
    if (next) { rovingPos = nodes.indexOf(next); retab(tool); next.focus(); }
  }
}

/* ---- drag to reorder (merge and images strips) ---- */

function wireStripDnD(tool) {
  const line = stripLine(tool);
  const caret = $(".strip__caret", line);
  const list = () => (tool === "merge" ? merge.files : convert.files);
  const orderAfter = tool === "merge" ? orderMergeAfter : orderConvertAfter;

  function cleanup() {
    if (dragEntry && dragEntry.group) dragEntry.group.classList.remove("is-dragging");
    dragEntry = null;
    dropTargetIdx = null;
    caret.classList.remove("is-on");
  }

  line.addEventListener("dragstart", (ev) => {
    const page = ev.target.closest(".strip__page");
    if (!page) { ev.preventDefault(); return; }
    dragEntry = list().find((entry) => entry.id === Number(page.dataset.file));
    if (!dragEntry) { ev.preventDefault(); return; }
    dragEntry.group.classList.add("is-dragging");
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(dragEntry.id));
  });

  line.addEventListener("dragover", (ev) => {
    if (!dragEntry) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    const groups = $$(".strip__group", line);
    if (!groups.length) return;
    dropTargetIdx = groups.length;
    let boundary = null;
    for (let i = 0; i < groups.length; i += 1) {
      const rect = groups[i].getBoundingClientRect();
      if (rect.width && ev.clientX < rect.left + rect.width / 2) {
        dropTargetIdx = i;
        boundary = rect;
        break;
      }
    }
    if (!boundary) boundary = groups[groups.length - 1].getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const x = ev.clientX < boundary.left + boundary.width / 2 ? boundary.left : boundary.right;
    caret.style.left = `${Math.round(x - lineRect.left)}px`;
    caret.style.top = `${Math.round(boundary.top - lineRect.top)}px`;
    caret.style.height = `${Math.round(boundary.height)}px`;
    caret.classList.add("is-on");
  });

  line.addEventListener("drop", (ev) => {
    if (!dragEntry) return;
    ev.preventDefault();
    if (dropTargetIdx !== null) orderAfter(dragEntry.id, dropTargetIdx);
    cleanup();
  });

  line.addEventListener("dragleave", (ev) => {
    if (!(ev.relatedTarget && line.contains(ev.relatedTarget))) caret.classList.remove("is-on");
  });

  line.addEventListener("dragend", cleanup);
}

/* ------------------------------------------------------------------ */
/* convert to PDF tool                                                 */
/* ------------------------------------------------------------------ */

/* Which app converts an extension (DESIGN: message names the missing app). */
const CONVERT_APPS = {
  word: ["doc", "docx", "rtf", "txt", "html", "htm", "odt"],
  excel: ["xls", "xlsx", "xlsm", "csv", "ods"],
  powerpoint: ["ppt", "pptx", "odp"],
};

/* "word" | "excel" | "powerpoint" | "md" | "image", or null. */
function convertKindOfFile(file) {
  const ext = extOf(file.name);
  for (const [kind, exts] of Object.entries(CONVERT_APPS)) {
    if (exts.includes(ext)) return kind;
  }
  if (ext === "md") return "md";
  return IMAGE_EXTS_JS.includes(ext) ? "image" : null;
}

const isConvertible = (file) => convertKindOfFile(file) !== null;

const anyConvertDoc = () =>
  convert.files.some((entry) => !entry.dead && entry.cKind !== "image");

function makeImageNode(entry, idx) {
  const wrap = el("button", "strip__page");
  wrap.type = "button";
  wrap.setAttribute("draggable", "true");
  wrap.tabIndex = -1;
  wrap.addEventListener("keydown", onSheetKey);
  wrap.dataset.file = String(entry.id);
  wrap.dataset.page = String(idx);
  const sheet = el("span", "strip__sheet strip__sheet--photo");
  const img = new Image();
  img.className = "strip__img";
  img.alt = "";
  img.onload = () => sheet.classList.remove("is-loading");
  img.onerror = () => failFile(entry, "to-pdf", COPY.badImage);
  img.src = entry.url; // object URL; browsers apply EXIF orientation
  sheet.appendChild(img);
  const node = { btn: wrap, sheet, label: el("span", "strip__label", "–") };
  wrap.appendChild(node.sheet);
  wrap.appendChild(node.label);
  entry.pageNodes = [node];
  return node;
}

function convertStatusText() {
  const files = convert.files.filter((entry) => !entry.dead);
  const count = files.length;
  if (!count) return "";
  const size = files.reduce((sum, entry) => sum + entry.size, 0);
  const noun = anyConvertDoc()
    ? (count === 1 ? "file" : "files")
    : (count === 1 ? "image" : "images");
  return `${count.toLocaleString("en")} ${noun}, ${fmtBytes(size)}`;
}

function convertStatusDirty() {
  if (!convert.working && !convert.resultUrl) {
    setStatus("to-pdf", convertStatusText(), false);
  }
  syncConvertControls();
}

function syncConvertControls() {
  const go = $("#to-pdf-go");
  const hasResult = Boolean(convert.resultUrl);
  go.hidden = hasResult;
  $("#to-pdf-download").hidden = !hasResult;
  $("#to-pdf-reset").hidden = !hasResult;
  go.disabled = !hasResult && (convert.files.length < 1 || convert.working);
  $("#to-pdf-zone").classList.toggle("dropzone--compact",
    convert.files.length > 0 && !hasResult);
}

/* Images render on the photo strip; any document moves the whole batch
   to file rows - documents have nothing to preview, and mixing one row
   into a photo strip would read like an error. */
function renderConvert() {
  const strip = $("#to-pdf-strip");
  const rows = $("#to-pdf-rows");
  const queue = anyConvertDoc();

  $$(".strip__group", stripLine("to-pdf")).forEach((group) => group.remove());
  rows.replaceChildren();

  strip.hidden = queue;
  rows.hidden = !queue;
  $(".strip__empty", strip).hidden = convert.files.length > 0;

  convert.files.forEach((entry) => {
    if (queue) {
      rows.appendChild(buildRow(entry));
      return;
    }
    buildGroup(entry, { alone: true, caption: true });
    makeImageNode(entry, 0);
    entry.pagesEl.appendChild(entry.pageNodes[0].btn);
    stripLine("to-pdf").appendChild(entry.group);
  });
  relabel("to-pdf");
  retab("to-pdf");
}

function buildRow(entry) {
  const row = el("div", "filerow");
  const name = el("p", "filerow__name", shortName(entry.name, 44));
  name.title = entry.name;
  const meta = el("p", "filerow__meta", fmtBytes(entry.size));
  const remove = el("button", "iconbtn filerow__remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${entry.name}`);
  remove.title = `Remove ${entry.name}`;
  remove.appendChild(svgIcon("i-x"));
  remove.addEventListener("click", () => removeFile(entry, entry.tool));
  row.appendChild(name);
  row.appendChild(meta);
  row.appendChild(remove);
  return row;
}

function convertAddFile(file) {
  if (!isConvertible(file)) return; // acceptFiles reports the wrong type
  clearNotice("to-pdf");
  clearConvertResult();
  const entry = makeEntry(file, "to-pdf");
  entry.cKind = convertKindOfFile(file);
  if (entry.cKind === "image") entry.url = URL.createObjectURL(file);
  convert.files.push(entry);
  renderConvert();
  convertStatusDirty();
}

function convertRemoveEntry(entry, silent = false) {
  entry.dead = true;
  if (entry.url) URL.revokeObjectURL(entry.url);
  convert.files = convert.files.filter((other) => other !== entry);
  rovingPos = 0;
  clearConvertResult();
  renderConvert();
  convertStatusDirty();
  if (!silent && !convert.files.length) {
    setStatus("to-pdf", "", false);
    clearNotice("to-pdf");
  }
}

function clearConvertResult() {
  if (convert.resultUrl) URL.revokeObjectURL(convert.resultUrl);
  convert.resultUrl = null;
  convert.resultName = null;
  syncConvertControls();
}

function resetConvert() {
  convert.files.forEach((entry) => {
    entry.dead = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
  });
  convert.files = [];
  rovingPos = 0;
  $$(".strip__group", stripLine("to-pdf")).forEach((group) => group.remove());
  $("#to-pdf-rows").replaceChildren();
  clearConvertResult();
  clearNotice("to-pdf");
  $("#to-pdf-reset").hidden = true;
  setStatus("to-pdf", "", false);
  renderConvert();
  syncConvertControls();
}

function convertRun() {
  if (convert.working) return;
  if (!convert.files.filter((entry) => !entry.dead).length) {
    setNotice("to-pdf", "Choose a file to convert.");
    return;
  }
  const sentCount = convert.files.length;
  convert.working = true;
  clearNotice("to-pdf");
  const progress = $("#to-pdf-progress");
  const bar = $(".progress__bar", progress);
  bar.style.width = "0%";
  progress.hidden = false;
  progress.classList.remove("is-indeterminate");
  const go = $("#to-pdf-go");
  go.disabled = true;
  setStatus("to-pdf", "", false);
  go.textContent = workingLabel("to-pdf");

  const form = new FormData();
  convert.files.forEach((entry) => form.append("files", entry.file, entry.name));

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/convert");
  xhr.responseType = "blob";
  xhr.timeout = REQUEST_TIMEOUT_MS;
  xhr.upload.onprogress = (ev) => paintProgress(progress, ev);
  xhr.onerror = () => {
    const err = new Error(COPY.serverDown);
    err.network = true;
    loseServer("to-pdf");
    finish(err);
  };
  xhr.ontimeout = () => finish(new Error(COPY.slow));
  xhr.onload = () => {
    markServerOkay();
    if (xhr.status >= 200 && xhr.status < 300) {
      const header = xhr.getResponseHeader("Content-Disposition") || "";
      finish(null, {
        blob: xhr.response,
        name: headerFileName(header, "converted.pdf"),
      });
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        let message = COPY.serverDown;
        try { message = JSON.parse(String(reader.result)).error || message; } catch { /* keep */ }
        finish(new Error(message));
      };
      reader.onerror = () => finish(new Error(COPY.serverDown));
      reader.readAsText(xhr.response);
    }
  };

  function finish(err, ok) {
    convert.working = false;
    progress.hidden = true;
    go.textContent = "Convert to PDF";
    if (err) {
      if (!err.network) setNotice("to-pdf", err.message);
      syncConvertControls();
      return;
    }
    clearConvertResult();
    convert.resultUrl = URL.createObjectURL(ok.blob);
    convert.resultName = ok.name;
    const link = $("#to-pdf-download");
    link.href = convert.resultUrl;
    link.setAttribute("download", ok.name);
    link.textContent = `Download ${ok.name}`;
    crossFade(link, go);
    showConvertResult(ok.blob, sentCount);
    syncConvertControls();
  }

  xhr.send(form);
}

/* Result line: one PDF -> "N pages, 123 KB" (pdf.js counts); a ZIP of
   several PDFs -> "N files, 123 KB". */
async function showConvertResult(blob, sentCount) {
  let summary;
  if (blob.type === "application/zip") {
    summary = `${sentCount} files, ${fmtBytes(blob.size)}`;
  } else {
    summary = fmtBytes(blob.size);
    try {
      const buf = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
      summary = `${fmtPages(doc.numPages)}, ${fmtBytes(blob.size)}`;
    } catch { /* size-only summary stands */ }
  }
  setStatus("to-pdf", summary, true);
}

async function loadConvertersNote() {
  const node = $("#to-pdf-converters");
  if (!node) return;
  try {
    const reply = await fetch("/api/converters");
    if (!reply.ok) return;
    const data = await reply.json();
    const trio = [
      ["word", "Word"],
      ["excel", "Excel"],
      ["powerpoint", "PowerPoint"],
    ];
    const join = (names) => names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : String(names[0]);
    const found = trio.filter(([key]) => data[key]).map(([, label]) => label);
    const missing = trio.filter(([key]) => !data[key]).map(([, label]) => label);
    if (!found.length && !missing.length) return;
    node.textContent = [
      found.length ? `${join(found)} found.` : "",
      missing.length ? `${join(missing)} not found.` : "",
    ].filter(Boolean).join(" ");
    node.hidden = false;
  } catch { /* server off: no note */ }
}

/* ------------------------------------------------------------------ */
/* info tool                                                           */
/* ------------------------------------------------------------------ */

function infoStripEmpty(empty) {
  $(".strip__empty", $("#info-strip")).hidden = !empty;
}

async function runInfo() {
  const entry = info.file;
  if (!entry) return;
  const form = new FormData();
  form.append("file", entry.file, entry.name);
  try {
    const reply = await fetch("/api/info", {
      method: "POST",
      body: form,
      signal: (typeof AbortSignal !== "undefined" && AbortSignal.timeout)
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
    markServerOkay(); // any reply at all means the server is reachable
    let data = null;
    try { data = await reply.json(); } catch { /* body not json */ }
    if (info.file !== entry) return; // user already swapped the file
    if (!reply.ok || !data || !data.pages) {
      setNotice("info", (data && data.error) || (reply.status === 413 ? COPY.tooLarge : COPY.serverDown));
      setStatus("info", "", false);
      return;
    }
    fillInfo(data);
    setStatus("info", `${fmtPages(data.pages)}, ${fmtBytes(data.size)}`, false);
  } catch (err) {
    if (info.file !== entry) return;
    if (err && err.name === "TimeoutError") setStatus("info", COPY.slow, false);
    else { loseServer("info"); setStatus("info", "", false); }
  }
}

function fillInfo(data) {
  const meta = data.metadata || {};
  const values = {
    pages: data.pages,
    size: data.size,
    version: data.version,
    created: meta.created,
    modified: meta.modified,
    title: meta.title,
    author: meta.author,
    subject: meta.subject,
    keywords: meta.keywords,
    creator: meta.creator,
    producer: meta.producer,
  };
  const format = {
    pages: (v) => Number(v).toLocaleString("en"),
    size: fmtBytes,
  };
  Object.keys(values).forEach((key) => {
    const node = $(`#info-${key}`);
    if (!node) return;
    const value = values[key];
    const shown = value === null || value === undefined || value === ""
      ? "—"
      : (format[key] ? format[key](value) : String(value));
    node.textContent = shown;
  });
  $("#info-details").hidden = false;
}

function removeFile(entry, tool) {
  entry.dead = true;
  closeDoc(entry);
  if (tool === "merge") {
    merge.files = merge.files.filter((other) => other !== entry);
    if (entry.group) entry.group.remove();
    rovingPos = 0;
    clearMergeResult();
    relabel("merge");
    retab("merge");
    mergeStatusDirty();
  } else if (tool === "to-pdf") {
    convertRemoveEntry(entry);
  } else if (PDF_TOOLS[tool]) {
    toolRemoveFile(entry, tool);
  } else {
    info.file = null;
    if (entry.group) entry.group.remove();
    $("#info-filerow").hidden = true;
    $("#info-zone").hidden = false;
    $("#info-details").hidden = true;
    setStatus("info", "", false);
    infoStripEmpty(true);
  }
}

/* ------------------------------------------------------------------ */
/* files: picker, drop zone, validation                                */
/* ------------------------------------------------------------------ */

const isPDF = (file) => extOf(file.name) === "pdf";
const IMAGE_EXTS_JS = ["jpg", "jpeg", "png", "bmp", "webp"];
const isImageFile = (file) => IMAGE_EXTS_JS.includes(extOf(file.name));

function acceptFiles(incoming, tool) {
  const kind = KIND[tool];
  const passes = kind === "convert" ? isConvertible : isPDF;
  const bad = incoming.find((file) => !passes(file));
  const huge = incoming.find((file) => passes(file) && file.size > CLIENT_UPLOAD_LIMIT);
  const empties = incoming.filter((file) => passes(file) && file.size === 0
    && file.size <= CLIENT_UPLOAD_LIMIT);
  const good = incoming.filter((file) => passes(file) && file.size > 0
    && file.size <= CLIENT_UPLOAD_LIMIT);

  // Add first; the added file's own clearNotice must not swallow this error (notice ordering).
  if (tool === "merge") good.forEach((file) => mergeAddFile(file));
  else if (kind === "convert") good.forEach((file) => convertAddFile(file));
  else if (good.length) toolAddFile(tool, good[0]);

  if (bad) {
    setNotice(tool, kind === "convert"
      ? COPY.wrongTypeConvert(extOf(bad.name) || "unknown")
      : COPY.wrongType(extOf(bad.name) || "unknown"));
  } else if (huge) {
    setNotice(tool, COPY.tooLarge);   // answered here, before the upload
  } else if (empties.length) {
    setNotice(tool, kind === "convert" ? COPY.emptyConvert : COPY.emptyFile);
  }
}

function wireZone(tool, multiple) {
  const zone = $(`#${tool}-zone`);
  const input = $(`#${tool}-input`);

  // The drop zone is a <label> for the file input: a click anywhere in it
  // and Enter or Space on the input open the picker natively, so only
  // the drag-and-drop and the change handling are wired here.

  let depth = 0;
  // is-over only for a real external file drag; an internal strip reorder
  // (dragEntry set) must not light the dropzone up as a drop target.
  const externalDrag = (ev) => Boolean(ev.dataTransfer) && !dragEntry &&
    Array.from(ev.dataTransfer.types || []).includes("Files");

  zone.addEventListener("dragenter", (ev) => {
    if (!externalDrag(ev)) return;
    depth += 1;
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragover", (ev) => {
    if (!externalDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => { depth -= 1; if (depth <= 0) { depth = 0; zone.classList.remove("is-over"); } });
  zone.addEventListener("drop", (ev) => {
    if (dragEntry) return; // internal reorder drop, not a file drop
    ev.preventDefault();
    depth = 0;
    zone.classList.remove("is-over");
    const incoming = Array.from(ev.dataTransfer.files || []);
    if (incoming.length) acceptFiles(incoming, tool);
  });

  input.addEventListener("change", () => {
    const incoming = Array.from(input.files || []);
    input.value = "";
    if (incoming.length) acceptFiles(incoming, tool);
  });

  input.multiple = multiple;
}

/* ------------------------------------------------------------------ */
/* reset + boot                                                        */
/* ------------------------------------------------------------------ */

function resetMerge() {
  merge.files.forEach((entry) => { entry.dead = true; closeDoc(entry); });
  merge.files = [];
  rovingPos = 0;
  $$(".strip__group", stripLine("merge")).forEach((group) => group.remove());
  clearMergeResult();
  clearNotice("merge");
  $("#merge-reset").hidden = true;
  setStatus("merge", "", false);
  syncMergeControls();
}

function crossFade(showEl, hideEl) {
  showEl.hidden = false;
  hideEl.hidden = true;
  if (reduceMotion() || !Element.prototype.animate) return;
  showEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
  hideEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-out" });
}

function wireTheme() {
  $$(".theme-toggle").forEach((btn) => btn.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "light" : "dark", true);
  }));
}

/* Folio: the left rail is retired — the shelf is the navigation. The old
   wireRail is gone; #toolindex links are plain hash-route anchors. */

function boot() {
  const params = new URLSearchParams(location.search);
  const rawTool = params.get("tool");

  initTheme();
  wireTheme();

  wireZone("merge", true);
  wireZone("info", false);
  SINGLE_PDF_TOOLS.forEach((name) => {
    wireZone(name, false);
    if (PDF_TOOLS[name].mode === "select") wireSelectStrip(name);
    $(`#${name}-go`).addEventListener("click", () => {
      if (name === "text") runText();
      else if (name === "watermark") runWatermark();
      else runTool(name);
    });
    $(`#${name}-reset`).addEventListener("click", () => resetTool(name));
    const row = $(`#${name}-filerow`);
    $(".filerow__remove", row).addEventListener("click", () => {
      if (toolState(name).entry) removeFile(toolState(name).entry, name);
    });
    const pagesInput = $(`#${name}-pages`);
    if (pagesInput) {
      pagesInput.addEventListener("input", () => {
        onRangeInput(name);
        if (name === "watermark") repaintWmPreviews(); // the range filters the live stamp preview too
      });
    }
  });

  // compress: the two levels are a pressed pair like the rotate angles
  $$(".compress-level").forEach((btn) => {
    btn.addEventListener("click", () => onCompressLevelClick(btn));
  });

  // lock/unlock: password fields with show/hide toggles
  wireEye($("#lock-eye"), $("#lock-password"));
  wireEye($("#lock-eye2"), $("#lock-confirm"));
  wireEye($("#unlock-eye"), $("#unlock-password"));
  ["lock-password", "lock-confirm"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => {
      clearNotice("lock");
      syncLockHint();
      syncControls("lock");
    });
  });
  $("#unlock-password").addEventListener("input", () => {
    if ($("#unlock-password").value) clearNotice("unlock");
    syncControls("unlock");
  });

  $("#text-copy").addEventListener("click", onTextCopy);
  wireZone("to-pdf", true);
  wireStripDnD("merge");
  wireStripDnD("to-pdf");

  // split: cut lines + mode radios
  stripLine("split").addEventListener("click", (ev) => {
    const cut = ev.target.closest(".strip__cut");
    if (cut) toggleCut(Number(cut.dataset.cut));
  });
  $$('input[name="split-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      $("#split-hint").textContent = splitMode() === "pages"
        ? "Every page becomes its own file." : "Click between two pages to add a cut line.";
      clearNotice("split");
      setIdleStatus("split");
      syncControls("split");
    });
  });

  // rotate: angle buttons
  $$(".rot-angle").forEach((btn) => {
    btn.addEventListener("click", () => onAngleClick(btn));
  });

  // watermark: kind, position choices, option inputs, live preview
  fillFontSelects();
  wmSwapKind();
  $$('input[name="watermark-kind"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      wmSwapKind();
      clearNotice("watermark");
      syncControls("watermark");
      repaintWmPreviews();
    });
  });
  $$(".wm-position").forEach((btn) => {
    btn.addEventListener("click", () => {
      wm.position = btn.dataset.position;
      $$(".wm-position").forEach((b) => {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      repaintWmPreviews();
    });
  });
  $("#watermark-image").addEventListener("change", () => {
    const input = $("#watermark-image");
    const file = input.files && input.files[0];
    if (wm.imageUrl) URL.revokeObjectURL(wm.imageUrl);
    wm.imageFile = file || null;
    wm.imageUrl = null;
    wm.imgW = 0;
    wm.imgH = 0;
    if (!file) { syncControls("watermark"); repaintWmPreviews(); return; }
    wm.imageUrl = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      wm.imgW = probe.naturalWidth;
      wm.imgH = probe.naturalHeight;
      clearNotice("watermark");
      syncControls("watermark");
      repaintWmPreviews();
    };
    probe.onerror = () => {
      // The browser agrees with the server here: only PNG/JPG belong.
      const ext = extOf(file.name) || "unknown";
      setNotice("watermark", `Watermark images work as PNG or JPG. This one is a .${ext}.`);
      wm.imageFile = null;
      if (wm.imageUrl) { URL.revokeObjectURL(wm.imageUrl); wm.imageUrl = null; }
      input.value = "";
      syncControls("watermark");
      repaintWmPreviews();
    };
    probe.src = wm.imageUrl;
  });
  ["#watermark-text", "#watermark-size", "#watermark-colour",
   "#watermark-angle", "#watermark-margin", "#watermark-scale"].forEach((id) => {
    $(id).addEventListener("input", () => {
      clearNotice("watermark");
      syncControls("watermark");
      repaintWmPreviews();
    });
  });
  $("#watermark-font").addEventListener("change", () => {
    clearNotice("watermark");
    repaintWmPreviews();
  });
  $("#watermark-opacity").addEventListener("input", () => {
    $("#watermark-opacity-hint").textContent = `${$("#watermark-opacity").value}%`;
    repaintWmPreviews();
  });
  $("#watermark-behind").addEventListener("change", repaintWmPreviews);

  // text > edit: its own zone, panel, queue and stage
  wireZone("edit", false);
  $("#edit-save").addEventListener("click", saveEdits);
  $("#edit-reset").addEventListener("click", () => resetTool("edit"));
  $(".filerow__remove", $("#edit-filerow")).addEventListener("click", () => {
    if (toolState("edit").entry) removeFile(toolState("edit").entry, "edit");
  });
  wireEye($("#edit-eye"), $("#edit-password"));
  const resubmitEditPassword = () => {
    const value = $("#edit-password").value;
    if (!value) { $("#edit-password").focus(); return; }
    clearNotice("edit");
    setStatus("edit", "Checking the password...", false);
    fetchSpans(value);
  };
  $("#edit-unlock").addEventListener("click", resubmitEditPassword);
  $("#edit-password").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); resubmitEditPassword(); }
  });
  $("#edit-password").addEventListener("input", () => clearNotice("edit"));
  $("#edit-apply").addEventListener("click", applyEdit);
  $("#edit-del").addEventListener("click", deleteSel);
  $("#edit-add").addEventListener("click", togglePlacing);
  ["#edit-bold", "#edit-italic"].forEach((id) => {
    $(id).addEventListener("click", () => {
      const b = $(id);
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    });
  });
  ["#edit-text", "#edit-size", "#edit-colour", "#edit-font"].forEach((id) => {
    $(id).addEventListener("input", () => clearNotice("edit"));
  });
  // A click on the page while "Add text" is pressed drops the draft box.
  $("#edit-canvasbox").addEventListener("click", (ev) => {
    if (!edit.placing || !edit.data) return;
    const box = $("#edit-canvasbox");
    const rect = box.getBoundingClientRect();
    const scale = edit.scale;
    const x = (ev.clientX - rect.left) / scale;
    const y = (ev.clientY - rect.top) / scale;
    const pageInfo = edit.data.pages[edit.page];
    const w = Math.min(220, pageInfo.width / 3);
    const h = 22;
    const bbox = [
      Math.max(0, Math.min(x - w / 2, pageInfo.width - w)),
      Math.max(0, Math.min(y - h / 2, pageInfo.height - h)),
    ];
    bbox.push(bbox[0] + w, bbox[1] + h);
    edit.placing = false;
    $("#edit-add").setAttribute("aria-pressed", "false");
    setStatus("edit", "", false);
    edit.draft = { page: edit.page, bbox };
    edit.sel = { kind: "draft" };
    buildOverlay();
    fillDraftPanel();
    $("#edit-text").focus({ preventScroll: true });
  });
  // Strip pages switch the edited page (the edit strip pages are plain
  // divs, so this is a delegated click, not per-node buttons).
  $("#edit-strip").addEventListener("click", (ev) => {
    const page = ev.target.closest(".strip__page");
    if (!page) return;
    const i = Number(page.dataset.page);
    if (Number.isInteger(i)) showEditPage(i);
  });
  // A window resize re-renders the open page at the new width.
  let editResizeTimer = null;
  window.addEventListener("resize", () => {
    if (!edit.entry || !edit.data) return;
    window.clearTimeout(editResizeTimer);
    editResizeTimer = window.setTimeout(() => showEditPage(edit.page), 150);
  });

  $("#merge-go").addEventListener("click", mergeRun);
  $("#merge-reset").addEventListener("click", resetMerge);
  $(".filerow__remove").addEventListener("click", () => { if (info.file) removeFile(info.file, "info"); });
  $("#to-pdf-go").addEventListener("click", convertRun);
  $("#to-pdf-reset").addEventListener("click", resetConvert);

  // Protect started the tab pattern; Pages and Text share it now.
  wireSubTabs("protect");
  wireSubTabs("pages");
  wireSubTabs("text");

  /* Folio: legacy deep links become hash routes. ?tool=merge… → #/<tool>;
     ?tool=lock|unlock → #/protect with that tab; ?tool=extract|delete →
     #/pages with that tab. ?demo=1 with no tool opened Merge (the old
     default panel) and keeps doing so. */
  let route = null;
  if (TOOL_IDS.includes(rawTool)) route = rawTool;
  else {
    const legacy = { lock: ["protect", "lock"], unlock: ["protect", "unlock"],
                     extract: ["pages", "extract"], delete: ["pages", "delete"],
                     edit: ["text", "edit"], read: ["text", "read"] };
    const hit = legacy[rawTool];
    if (hit) { route = hit[0]; subTabState(hit[0]).pending = hit[1]; }
    else if (params.get("demo") === "1") route = "merge";
  }
  if (route) {
    const u = new URL(location.href);
    u.searchParams.delete("tool");
    const st = subTabs[route];
    const tab = st && st.pending ? st.pending : (TAB_GROUPS[route] ? subTabState(route).current : null);
    u.hash = tab ? `#/${route}/${tab}` : `#/${route}`;
    history.replaceState(null, "", u);
  }

  applyRoute(false);
  syncMergeControls();
  infoStripEmpty(true);
  syncConvertControls();
  loadConvertersNote();

  if (params.get("demo") === "1") {
    // A raw tool name that names a demo key wins, so ?tool=edit&demo=1
    // fills the Edit tab, not the Read tab the route resolves to.
    const knownDemos = new Set(["info", "extract", "delete", "pages", "rotate",
      "split", "compress", "lock", "unlock", "text", "watermark", "edit", "to-pdf"]);
    const demoTool = knownDemos.has(rawTool) ? rawTool : (route || "merge");
    loadDemo(demoTool);
  }

  /* Folio: Three.js loads at startup, asynchronously after the shell has
     painted, so returning to the shelf from a tool is instant. */
  requestAnimationFrame(() => requestAnimationFrame(() => { ensureShelf(); }));
}

async function loadDemo(tool = "merge") {
  // ?demo=1 helper: fills a tool's strip with samples, purely for manual
  // testing and screenshots.
  const picks = {
    info: { accept: "pdf", names: ["assignment.pdf"] },
    extract: { accept: "pdf", names: ["assignment.pdf"] },
    delete: { accept: "pdf", names: ["assignment.pdf"] },
    pages: { accept: "pdf", names: ["assignment.pdf"] },
    rotate: { accept: "pdf", names: ["assignment.pdf"] },
    split: { accept: "pdf", names: ["assignment.pdf"] },
    compress: { accept: "pdf", names: ["assignment.pdf"] },
    lock: { accept: "pdf", names: ["assignment.pdf"] },
    unlock: { accept: "pdf", names: ["locked.pdf"] },
    text: { accept: "pdf", names: ["text20.pdf"] },
    watermark: { accept: "pdf", names: ["assignment.pdf"] },
    edit: { accept: "pdf", names: ["word-export.pdf"] },
    "to-pdf": { accept: "image", names: ["notes-photo.jpg", "board-photo.jpg", "slide-photo.jpg"] },
  };
  const mergePicks = { accept: "pdf", names: ["assignment.pdf", "lab-record.pdf", "notes.pdf"] };
  const pick = picks[tool] || mergePicks;
  // "pages" fills whichever sub-tab tool it wraps (extract is the default);
  // "edit" fills the edit tab's own state object.
  const target = tool === "pages" ? "extract" : tool;
  for (const name of pick.names) {
    try {
      const reply = await fetch(`/samples/${name}`);
      if (!reply.ok) return;
      const blob = await reply.blob();
      const type = pick.accept === "image" ? "image/jpeg" : "application/pdf";
      const file = new File([blob], name, { type });
      if (target === "info") infoAddFile(file);
      else if (target === "to-pdf") convertAddFile(file);
      else if (PDF_TOOLS[target] || target === "edit") toolAddFile(target, file);
      else mergeAddFile(file);
    } catch { /* server off: demo stays empty */ }
  }
  rovingPos = 0;
  retab("merge");
  retab("to-pdf");
}

function infoAddFile(file) {
  toolAddFile("info", file);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

/* ------------------------------------------------------------------ */
/* Navigation: the shelf is home, the tools are hash routes.           */
/* Every tool opens as #/<tool>; the browser's Back returns to the     */
/* shelf because route changes are history entries. The scene mounts   */
/* once at startup; a tool open only pauses its loop.                  */
/* ------------------------------------------------------------------ */

let currentRoute = null;        // null = home (the shelf)
let shelfModule = null;         // the dynamic import, kept for pause/resume
let shelfReady = false;
let shelfPaused = false;
let shelfFailed = false;
let shelfWantedActive = true;   // run state wanted before the module landed

function shelfHasWebGL() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch { return false; }
}

function routeFromLocation() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const parts = h.split("/");
  const tool = TOOL_IDS.includes(parts[0]) ? parts[0] : null;
  if (tool && TAB_GROUPS[tool] && parts[1] && parts[1] in TAB_GROUPS[tool]) {
    subTabState(tool).pending = parts[1];
  }
  return tool;
}

function setToolIndexCurrent(route) {
  $$("#toolindex .toolindex__item").forEach((a) => {
    if (route && a.dataset.tool === route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function runShelf(active) {
  shelfWantedActive = active;
  if (!shelfReady || !shelfModule) return;
  if (active && shelfPaused) { shelfPaused = false; shelfModule.resumeShelf(); }
  else if (!active && !shelfPaused) { shelfPaused = true; shelfModule.pauseShelf(); }
}

function showToolIndexFallback() {
  const idx = $("#toolindex");
  const frame = $("#shelf-root");
  const note = $("#toolindex-note");
  if (idx) { idx.classList.remove("wb__sr"); idx.classList.add("toolindex--open"); }
  if (frame) frame.hidden = true;
  if (note) note.hidden = false;
}

async function ensureShelf() {
  if (shelfModule || shelfFailed) return;
  if (!shelfHasWebGL()) { shelfFailed = true; showToolIndexFallback(); return; }
  try {
    shelfModule = await import("/static/shelf/shelf.js");
    shelfModule.setToolOpener((id) => {
      runShelf(false);                 // stop the loop before the view flips
      if (location.hash === `#/${id}`) applyRoute(true);
      else location.hash = `#/${id}`;
    });
    await shelfModule.mountShelf();
    shelfReady = true;
    shelfPaused = false;
    runShelf(currentRoute === null);   // a tool is open → pause right away
  } catch (err) {
    console.error("Shelf failed to load:", err);
    shelfFailed = true;
    showToolIndexFallback();
  }
}

function applyRoute(fromNav) {
  const route = routeFromLocation();
  const homeView = $("#view-home");
  const toolView = $("#view-tool");
  const changed = route !== currentRoute;
  currentRoute = route;
  if (!route) {
    homeView.hidden = false;
    toolView.hidden = true;
    document.title = "Folio";
    setToolIndexCurrent(null);
    runShelf(true);
    if (fromNav && changed) $("#view-home").focus({ preventScroll: true });
  } else {
    homeView.hidden = true;
    toolView.hidden = false;
    showTool(route);
    setToolIndexCurrent(route);
    runShelf(false);
    if (fromNav && changed) $("#view-tool").focus({ preventScroll: true });
  }
}

window.addEventListener("hashchange", () => applyRoute(true));

// Hiding the tab pauses the loop; coming back resumes whatever view is
// current (the shelf only runs while it is on screen).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) runShelf(false);
  else runShelf(currentRoute === null);
});
