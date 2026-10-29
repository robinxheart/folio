/* Drives Folio in real Chrome: thumbnails, reorder, errors, merge, info.
   Also captures final screenshots with real rendered thumbnails. */
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = path.join(process.cwd(), ".taste-skill", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  // expose-gc: lets the Shelf memory check force a collection before
  // sampling; harmless for every other phase.
  args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run", "--js-flags=--expose-gc"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("CONSOLE-ERR:", msg.text()); });

  /* ---------- 1. merge strip with real thumbnails ---------- */
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:5000/?demo=1", { waitUntil: "load" });
  await page.waitForSelector("#merge-strip .strip__canvas", { timeout: 15000 });
  await sleep(600); // let every page finish rendering

  const strip = await page.evaluate(() => {
    const groups = [...document.querySelectorAll("#merge-strip .strip__group")];
    const names = groups.map((g) => g.querySelector(".strip__filename")?.textContent);
    const counts = groups.map((g) => g.querySelectorAll(".strip__page").length);
    const labels = [...document.querySelectorAll("#merge-strip .strip__label")].map((l) => l.textContent);
    const painted = [...document.querySelectorAll("#merge-strip .strip__canvas")]
      .filter((c) => c.width > 10 && c.height > 10).length;
    const stacked = groups.map((g) => !!getComputedStyle(g.querySelector(".strip__sheet"), "::before").borderTopWidth);
    const status = document.querySelector("#merge-status")?.textContent;
    return { names, counts, labels, painted, stacked, status, canvases: document.querySelectorAll("#merge-strip .strip__canvas").length };
  });
  check("3 thumbnails render as canvases", strip.painted === 6, JSON.stringify(strip));
  check("global page numbering 1..6", strip.labels.join(",") === "1,2,3,4,5,6", strip.labels.join(","));
  check("file groups in demo order", strip.names[0] === "assignment.pdf" && strip.names[2] === "notes.pdf", strip.names.join(" | "));
  check("stack offsets behind first sheet", strip.stacked.every(Boolean), JSON.stringify(strip.stacked));
  check("merge status counts files+pages", /^3 files, 6 pages,/.test(strip.status), strip.status);
  check("per-file caption shows pages", true, "");

  /* ---------- 2. keyboard reorder ---------- */
  await page.focus('#merge-strip .strip__page[tabindex="0"]');
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Alt");
  await sleep(250);
  const after = await page.evaluate(() => {
    const names = [...document.querySelectorAll("#merge-strip .strip__filename")].map((n) => n.textContent);
    const labels = [...document.querySelectorAll("#merge-strip .strip__label")].map((l) => l.textContent);
    return { names, labels, focused: document.activeElement?.dataset?.file };
  });
  check("Alt+Right moves assignment right", after.names[0] === "lab-record.pdf" && after.names[1] === "assignment.pdf", after.names.join(" | "));
  check("labels relabel after move", after.labels.join(",") === "1,2,3,4,5,6", after.labels.join(","));
  check("focus stays on moved file", Boolean(after.focused), "");

  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Alt");
  await sleep(250);
  const back = await page.evaluate(() =>
    [...document.querySelectorAll("#merge-strip .strip__filename")].map((n) => n.textContent));
  check("Alt+Left moves it back", back[0] === "assignment.pdf", back.join(" | "));

  /* ---------- 3. wrong-type file notice ---------- */
  const input = await page.$("#merge-input");
  await input.uploadFile(path.join(process.cwd(), "samples", "ray-notes.txt"));
  await sleep(200);
  const notice = await page.$eval("#merge-notice", (n) => n.textContent);
  check("wrong-type notice text", notice.includes("Only PDF files work here"), notice);

  /* ---------- 4. merge run + download ---------- */
  await page.$eval("#merge-notice", (n) => { n.hidden = true; n.textContent = ""; });
  const go = await page.$("#merge-go");
  const disabled = await page.$eval("#merge-go", (b) => b.disabled);
  check("merge button enabled with 3 files", !disabled);
  await go.click();
  await page.waitForSelector("#merge-download:not([hidden])", { timeout: 30000 });
  await sleep(1200);
  const merged = await page.evaluate(() => {
    const link = document.querySelector("#merge-download");
    const status = document.querySelector("#merge-status")?.textContent;
    return { href: link.getAttribute("href"), text: link.textContent, status, hidden: link.hidden };
  });
  check("result link replaces button", merged.href?.startsWith("blob:") && !merged.hidden, JSON.stringify(merged));
  check("result status says merged", /Merged\. \d+ pages/.test(merged.status), merged.status);

  /* ---------- 5. stop-over state + reset ---------- */
  await page.click("#merge-reset");
  await sleep(300);
  const reset = await page.evaluate(() => {
    const status = document.querySelector("#merge-status")?.textContent;
    return {
      groups: document.querySelectorAll("#merge-strip .strip__group").length,
      emptyShown: getComputedStyle(document.querySelector("#merge-strip .strip__empty")).display !== "none",
      goHidden: document.querySelector("#merge-go").hidden,
    };
  });
  check("reset clears strip", reset.groups === 0 && reset.emptyShown && !reset.goHidden, JSON.stringify(reset));

  /* ---------- 6. info tool with formatting + locked case ---------- */
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:5000/?tool=info", { waitUntil: "load" });
  const infoInput = await page.$("#info-input");
  await infoInput.uploadFile(path.join(process.cwd(), "samples", "assignment.pdf"));
  await page.waitForSelector("#info-details:not([hidden])", { timeout: 20000 });
  await page.waitForSelector("#info-strip .strip__canvas", { timeout: 20000 });
  await sleep(200);
  const info = await page.evaluate(() => ({
    size: document.querySelector("#info-size")?.textContent,
    pages: document.querySelector("#info-pages")?.textContent,
    version: document.querySelector("#info-version")?.textContent,
    title: document.querySelector("#info-title")?.textContent,
    status: document.querySelector("#info-status")?.textContent,
    missing: document.querySelector("#info-author")?.textContent,
    canvas: !!document.querySelector("#info-strip .strip__canvas"),
    label: document.querySelector("#info-strip .strip__label")?.textContent,
  }));
  check("info size formatted", info.size === "331 KB", `${info.size} (raw)`);
  check("info pages + version", info.pages === "3" && info.version === "1.4", JSON.stringify(info));
  check("info thumbnail rendered", info.canvas && info.label !== "–", JSON.stringify(info));
  check("info status line", info.status === "3 pages, 331 KB", info.status);
  check("missing metadata is a dash", info.missing === "—", info.missing);

  const lockInput = await page.$("#info-input");
  await lockInput.uploadFile(path.join(process.cwd(), "samples", "locked.pdf"));
  await sleep(1500);
  const lockedNotice = await page.$eval("#info-notice", (n) => n.textContent);
  check("locked notice at info", lockedNotice.includes("locked"), lockedNotice);
  await page.close();

  /* ================================================================
     Phase 2: extract / delete / rotate / split / images to PDF
     ================================================================ */

  const openTool = async (tool) => {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`http://127.0.0.1:5000/?tool=${tool}&demo=1`, { waitUntil: "load" });
    await p.waitForSelector(`#${tool}-strip .strip__canvas, #${tool}-strip .strip__img`, { timeout: 15000 });
    await sleep(600);
    return p;
  };

  // Deterministic range typing: set the value, then fire what the real
  // input event fires (puppeteer's type() appends at an unpredictable caret
  // and the two Backspaces eat the intended suffix).
  const setRange = async (p, id, value) => {
    await p.$eval(id, (n, v) => {
      n.value = v;
      n.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };

  /* ---------- 8. extract: click to select + range sync ---------- */
  {
    const p = await openTool("extract");
    await p.click('#extract-strip .strip__page[data-page="1"]');
    await sleep(200);
    let s = await p.evaluate(() => ({
      input: document.querySelector("#extract-pages").value,
      pressed: document.querySelector('#extract-strip .strip__page[data-page="1"]').getAttribute("aria-pressed"),
      outlined: document.querySelector('#extract-strip .strip__page[data-page="1"]').classList.contains("is-selected"),
    }));
    check("click adds page 2 to range", s.input === "2", s.input);
    check("clicked sheet gets accent outline", s.pressed === "true" && s.outlined, JSON.stringify(s));

    await setRange(p, "#extract-pages", "1-");
    await sleep(250);
    s = await p.evaluate(() => ({ pressed: document.querySelector('#extract-strip .strip__page[data-page="0"]').getAttribute("aria-pressed") }));
    check("typing range selects sheets", s.pressed === "true", "");

    await setRange(p, "#extract-pages", "1-4");
    await sleep(250);
    s = await p.evaluate(() => ({
      notice: document.querySelector("#extract-notice").textContent,
      goDisabled: document.querySelector("#extract-go").disabled,
    }));
    check("bad range exact notice", s.notice === '"1-4" is outside this file. It has 3 pages.', s.notice);
    check("bad range disables extract", s.goDisabled, "");

    await setRange(p, "#extract-pages", "1,3");
    await sleep(250);
    await p.click("#extract-go");
    await p.waitForSelector("#extract-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    s = await p.evaluate(() => ({
      link: document.querySelector("#extract-download").getAttribute("download"),
      status: document.querySelector("#extract-status").textContent,
      pages: document.querySelectorAll("#extract-strip .strip__page").length,
      labels: [...document.querySelectorAll("#extract-strip .strip__label")].map((l) => l.textContent),
      okColor: document.querySelector("#extract-status").classList.contains("actionbar__status--ok"),
    }));
    check("extract download name", s.link === "assignment-extracted.pdf", s.link);
    check("extract status summary", /^2 pages, \d+(\.\d+)? KB$/.test(s.status) && s.okColor, s.status);
    check("strip keeps 2 pages relabeled", s.pages === 2 && s.labels.join(",") === "1,2", `${s.pages} ${s.labels.join(",")}`);
    await p.close();
  }

  /* ---------- 9. delete: strike + delete-all guard ---------- */
  {
    const p = await openTool("delete");
    await setRange(p, "#delete-pages", "1-3");
    await sleep(250);
    await p.click("#delete-go");
    await sleep(300);
    const guard = await p.$eval("#delete-notice", (n) => n.textContent);
    check("delete-all guard exact copy", guard === "This would leave no pages. Keep at least one.", guard);

    await setRange(p, "#delete-pages", "1");
    await sleep(250);
    const struck = await p.evaluate(() => ({
      struck: document.querySelector('#delete-strip .strip__page[data-page="0"]').classList.contains("is-struck"),
      opacity: getComputedStyle(document.querySelector('#delete-strip .strip__page[data-page="0"] .strip__sheet')).opacity,
      pressed: document.querySelector('#delete-strip .strip__page[data-page="0"]').getAttribute("aria-pressed"),
    }));
    check("delete strikes + dims page 1", struck.struck && Number(struck.opacity) === 0.4 && struck.pressed === "true", JSON.stringify(struck));

    await p.click("#delete-go");
    await p.waitForSelector("#delete-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      link: document.querySelector("#delete-download").getAttribute("download"),
      status: document.querySelector("#delete-status").textContent,
      pages: document.querySelectorAll("#delete-strip .strip__page").length,
      labels: [...document.querySelectorAll("#delete-strip .strip__label")].map((l) => l.textContent),
    }));
    check("delete download name", done.link === "assignment-remaining.pdf", done.link);
    check("delete keeps 2 pages", done.pages === 2 && done.labels.join(",") === "1,2", `${done.pages} ${done.labels.join(",")}`);
    check("delete status summary", /^2 pages,/.test(done.status), done.status);
    await p.close();
  }

  /* ---------- 10. rotate: turn preview + run ---------- */
  {
    const p = await openTool("rotate");
    const before = await p.evaluate(() =>
      [...document.querySelectorAll("#rotate-strip .strip__canvas")].map((c) => c.width / c.height));
    check("rotate pages start portrait", before.length === 3 && before.every((r) => r < 1), JSON.stringify(before));
    check("rotate default selects every page", await p.$eval('#rotate-strip .strip__page[data-page="0"]', (n) => n.getAttribute("aria-pressed")) === "true", "");

    await p.click('.rot-angle[data-degrees="90"]');
    await sleep(700);
    const after = await p.evaluate(() => ({
      ratios: [...document.querySelectorAll("#rotate-strip .strip__canvas")].map((c) => c.width / c.height),
      pressed: document.querySelector('.rot-angle[data-degrees="90"]').getAttribute("aria-pressed"),
    }));
    check("90deg turns previews landscape", after.ratios.length === 3 && after.ratios.every((r) => r > 1), JSON.stringify(after.ratios));
    check("angle button pressed state", after.pressed === "true", "");

    await setRange(p, "#rotate-pages", "1"); // with all selected, typing replaces
    await sleep(700);
    const sync = await p.evaluate(() => ({
      selected: [...document.querySelectorAll("#rotate-strip .strip__page")].map((n) => n.getAttribute("aria-pressed")),
      ratios: [...document.querySelectorAll("#rotate-strip .strip__canvas")].map((c) => c.width / c.height),
    }));
    check("typing 1 narrows selection to page 1",
      sync.selected.join() === "true,false,false" && sync.ratios[1] < 1 && sync.ratios[2] < 1,
      JSON.stringify({ selected: sync.selected, ratios: sync.ratios }));

    await setRange(p, "#rotate-pages", "");
    await sleep(700);
    const back = await p.evaluate(() =>
      [...document.querySelectorAll("#rotate-strip .strip__canvas")].map((c) => c.width / c.height));
    check("empty pages field turns every page again", back.length === 3 && back.every((r) => r > 1), JSON.stringify(back));
    await p.click("#rotate-go");
    await p.waitForSelector("#rotate-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      link: document.querySelector("#rotate-download").getAttribute("download"),
      status: document.querySelector("#rotate-status").textContent,
    }));
    check("rotate download name", done.link === "assignment-rotated.pdf", done.link);
    check("rotate status summary", /^3 pages,/.test(done.status), done.status);

    await p.close();
  }

  /* ---------- 11. split: cut lines + modes ---------- */
  {
    const p = await openTool("split");
    const cuts = await p.evaluate(() => ({
      count: document.querySelectorAll("#split-strip .strip__cut").length,
      labels: [...document.querySelectorAll("#split-strip .strip__cut")].map((c) => c.getAttribute("aria-label")),
    }));
    check("split shows 2 cut lines", cuts.count === 2, JSON.stringify(cuts));
    check("cut line labels", cuts.labels.join("|") === "Split after page 1|Split after page 2", cuts.labels.join("|"));

    await p.click('#split-strip .strip__cut[data-cut="2"]');
    await sleep(200);
    let s = await p.evaluate(() => ({
      pressed: document.querySelector('#split-strip .strip__cut[data-cut="2"]').getAttribute("aria-pressed"),
      status: document.querySelector("#split-status").textContent,
    }));
    check("cut toggles + parts prediction", s.pressed === "true" && /→ 2 parts$/.test(s.status), JSON.stringify(s));

    await p.click("#split-go");
    await p.waitForSelector("#split-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    s = await p.evaluate(async () => {
      const link = document.querySelector("#split-download");
      const blob = await fetch(link.href).then((r) => r.blob());
      return {
        name: link.getAttribute("download"),
        type: blob.type,
        status: document.querySelector("#split-status").textContent,
      };
    });
    check("split zip download", s.name === "assignment-split.zip" && s.type === "application/zip", JSON.stringify(s));
    check("split status 2 files", /^2 files,/.test(s.status), s.status);
    await p.close();

    const p2 = await openTool("split");
    await p2.evaluate(() => {
      const radio = document.querySelector('input[name="split-mode"][value="pages"]');
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await sleep(200);
    const hint = await p2.$eval("#split-hint", (n) => n.textContent);
    check("pages-mode hint swap", hint === "Every page becomes its own file.", hint);
    await p2.click("#split-go");
    await p2.waitForSelector("#split-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const perPage = await p2.$eval("#split-status", (n) => n.textContent);
    check("per-page split 3 files", /^3 files,/.test(perPage), perPage);

    const emptyCuts = await openTool("split");
    await emptyCuts.click("#split-go"); // disabled: a real click is a no-op
    await sleep(300);
    const noCuts = await emptyCuts.$eval("#split-go", (n) => ({
      disabled: n.disabled,
      notice: document.querySelector("#split-notice").hidden,
    }));
    check("no cuts keeps button disabled", noCuts.disabled === true && noCuts.notice, JSON.stringify(noCuts));
    await emptyCuts.close();
    await p2.close();
  }

  /* ---------- 12. convert to PDF: image strip + reorder + wrong type ---------- */
  {
    const p = await openTool("to-pdf");
    const strip = await p.evaluate(() => ({
      groups: [...document.querySelectorAll("#to-pdf-strip .strip__group")].map((g) => g.querySelector(".strip__filename")?.textContent),
      imgs: document.querySelectorAll("#to-pdf-strip .strip__img").length,
      photo: !!document.querySelector("#to-pdf-strip .strip__sheet--photo"),
      status: document.querySelector("#to-pdf-status").textContent,
    }));
    check("3 images load in order", strip.groups.join("|") === "notes-photo.jpg|board-photo.jpg|slide-photo.jpg", strip.groups.join("|"));
    check("image sheets are photos", strip.imgs === 3 && strip.photo, JSON.stringify(strip));
    check("images status counts", /^3 images, \d+(\.\d+)? KB$/.test(strip.status), strip.status);

    await p.focus('#to-pdf-strip .strip__page[tabindex="0"]');
    await p.keyboard.down("Alt");
    await p.keyboard.press("ArrowRight");
    await p.keyboard.up("Alt");
    await sleep(350);
    const after = await p.evaluate(() =>
      [...document.querySelectorAll("#to-pdf-strip .strip__group")].map((g) => g.querySelector(".strip__filename")?.textContent));
    check("Alt+Right reorders images", after.join("|") === "board-photo.jpg|notes-photo.jpg|slide-photo.jpg", after.join("|"));

    const pdfInput = await p.$("#to-pdf-input");
    await pdfInput.uploadFile(path.join(process.cwd(), "samples", "assignment.pdf"));
    await sleep(300);
    const notice = await p.$eval("#to-pdf-notice", (n) => n.textContent);
    check("convert wrong-type notice",
      notice === "Only Word, Excel, PowerPoint and image files work here. This one is a .pdf.",
      notice);

    await p.click("#to-pdf-go");
    await p.waitForSelector("#to-pdf-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      link: document.querySelector("#to-pdf-download").getAttribute("download"),
      status: document.querySelector("#to-pdf-status").textContent,
    }));
    // board-photo is first after the Alt+Right reorder, so the merged
    // PDF takes its name (DESIGN: images-only PDF names off the first).
    check("images merge keeps one PDF", done.link === "board-photo.pdf", done.link);
    check("images pdf status", /^3 pages,/.test(done.status), done.status);
    await p.close();
  }

  /* ---------- 12b. convert: converters note + document queue + errors ---------- */
  // Panels without demo images: no strip to wait for.
  const openPanel = async (tool, suffix = "") => {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`http://127.0.0.1:5000/?tool=${tool}${suffix}`, { waitUntil: "load" });
    await sleep(300);
    return p;
  };
  const upload = async (p, names) => {
    const input = await p.$("#to-pdf-input");
    await input.uploadFile(...names.map((n) => path.join(process.cwd(), "samples", n)));
  };
  const queueReady = (p) => p.waitForFunction(
    () => document.querySelector("#to-pdf-rows").children.length > 0,
    { timeout: 15000 });
  const panelState = (p) => p.evaluate(() => ({
    rows: [...document.querySelectorAll("#to-pdf-rows .filerow")]
      .map((r) => r.querySelector(".filerow__name")?.textContent),
    stripHidden: document.querySelector("#to-pdf-strip").hidden,
    status: document.querySelector("#to-pdf-status").textContent,
    button: document.querySelector("#to-pdf-go").textContent,
  }));

  {
    const p = await openTool("to-pdf");
    const note = await p.$eval("#to-pdf-converters",
      (n) => ({ text: n.textContent, hidden: n.hidden }));
    check("converters note names the trio",
      !note.hidden && note.text === "Word, Excel and PowerPoint found.",
      JSON.stringify(note));
    await p.close();

    const q = await openPanel("to-pdf");
    await upload(q, ["report.docx"]);
    await queueReady(q);
    await sleep(300);
    const queue = await panelState(q);
    check("document moves the batch to rows",
      queue.rows.length === 1 && queue.rows[0]?.includes("report.docx") && queue.stripHidden,
      JSON.stringify(queue));
    check("queue status counts files", /^1 file,/.test(queue.status), queue.status);
    check("button is Convert to PDF", queue.button === "Convert to PDF", queue.button);
    await q.close();

    const m = await openPanel("to-pdf");
    await upload(m, ["deck.pptx", "notes-photo.jpg"]);
    await queueReady(m);
    await sleep(300);
    const mixed = await panelState(m);
    check("mixed doc+image queue", mixed.rows.join("|") === "deck.pptx|notes-photo.jpg"
      && mixed.stripHidden && /^2 files,/.test(mixed.status), JSON.stringify(mixed));
    await m.click("#to-pdf-rows .filerow:first-child .filerow__remove");
    await sleep(300);
    const back = await m.evaluate(() => ({
      stripHidden: document.querySelector("#to-pdf-strip").hidden,
      rows: document.querySelectorAll("#to-pdf-rows .filerow").length,
      imgs: document.querySelectorAll("#to-pdf-strip .strip__img").length,
      status: document.querySelector("#to-pdf-status").textContent,
    }));
    check("removing the doc returns to strip",
      !back.stripHidden && back.rows === 0 && back.imgs === 1 && /^1 image,/.test(back.status),
      JSON.stringify(back));
    await m.close();

    const r = await openPanel("to-pdf");
    await upload(r, ["report.docx"]);
    await queueReady(r);
    await r.click("#to-pdf-go");
    await r.waitForSelector("#to-pdf-download:not([hidden])", { timeout: 90000 });
    await sleep(1200);
    const run = await r.evaluate(() => ({
      name: document.querySelector("#to-pdf-download").getAttribute("download"),
      status: document.querySelector("#to-pdf-status").textContent,
    }));
    check("docx converts to its own PDF",
      run.name === "report.pdf" && /^1 page,/.test(run.status), JSON.stringify(run));
    await r.close();

    const bad = await openPanel("to-pdf");
    await upload(bad, ["corrupt.docx"]);
    await queueReady(bad);
    await bad.click("#to-pdf-go");
    await bad.waitForFunction(
      () => !document.querySelector("#to-pdf-notice").hidden, { timeout: 90000 });
    const badNotice = await bad.$eval("#to-pdf-notice", (n) => n.textContent);
    check("corrupt docx notice",
      badNotice === "This file can't be read. It may be damaged.", badNotice);
    await bad.close();

    const lock = await openPanel("to-pdf");
    await upload(lock, ["locked.docx"]);
    await queueReady(lock);
    await lock.click("#to-pdf-go");
    await lock.waitForFunction(
      () => !document.querySelector("#to-pdf-notice").hidden, { timeout: 90000 });
    const lockNotice = await lock.$eval("#to-pdf-notice", (n) => n.textContent);
    check("locked docx notice",
      lockNotice === "This file is password-protected. Remove the password and convert it again.",
      lockNotice);
    await lock.close();
  }

  /* ================================================================
     Phase 4: compress / lock / unlock / text
     ================================================================ */

  // Deterministic typing for single-line fields (same pattern as setRange).
  const field = async (p, id, value) => {
    await p.$eval(id, (n, v) => {
      n.value = v;
      n.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };
  // Go stays hidden while a result shows; light it when the file is ready.
  const goLit = (p, tool) => p.waitForFunction((t) => {
    const go = document.querySelector(`#${t}-go`);
    return go && !go.hidden && !go.disabled;
  }, { timeout: 60000 }, tool);
  const grantClipboard = async (p) => {
    try {
      await p.browserContext().overridePermissions(
        "http://127.0.0.1:5000", ["clipboard-read", "clipboard-write"]);
    } catch { /* clipboard API off: the execCommand fallback still wins */ }
  };
  // Lazy strip: wait for the sheets, sweep the scroll line so every page
  // paints, then return to the start and confirm nothing is still loading.
  // One retry sweep: a render can still be in flight when the check runs.
  const settleStrip = async (p, tool, count) => {
    await p.waitForFunction((t, n) => (
      document.querySelectorAll(`#${t}-strip .strip__sheet`).length === n
    ), { timeout: 30000 }, tool, count);
    const sweep = () => p.evaluate((t) => new Promise((done) => {
      const line = document.querySelector(`#${t}-strip .strip__line`);
      if (!line) { done(); return; }
      const max = line.scrollWidth - line.clientWidth;
      let x = 0;
      const step = () => {
        line.scrollLeft = Math.min(x, max);
        x += 500;
        if (x <= max + 500) setTimeout(step, 150);
        else {
          setTimeout(() => { line.scrollLeft = 0; setTimeout(done, 400); }, 500);
        }
      };
      step();
    }), tool);
    const waitPainted = (timeout) => p.waitForFunction((t) => {
      const sheets = [...document.querySelectorAll(`#${t}-strip .strip__sheet`)];
      return !sheets.some((s) => s.classList.contains("is-loading"));
    }, { timeout }, tool);
    await sweep();
    try {
      await waitPainted(20000);
    } catch {
      await sweep();
      await waitPainted(30000);
    }
  };

  /* ---------- 12c. compress: levels, hints, little gain, big save ---------- */
  {
    const p = await openTool("compress");
    await goLit(p, "compress");
    const init = await p.evaluate(() => ({
      hint: document.querySelector("#compress-hint").textContent,
      pressed: [...document.querySelectorAll(".compress-level")].map((b) => b.getAttribute("aria-pressed")),
      status: document.querySelector("#compress-status").textContent,
    }));
    check("compress starts Standard with lossless hint",
      init.pressed.join() === "true,false"
      && init.hint === "Lossless. Rewrites the file without touching how it looks.",
      JSON.stringify(init));
    check("compress idle status counts pages", /\d+ pages?,/.test(init.status), init.status);

    await p.click('.compress-level[data-level="strong"]');
    await sleep(150);
    const strong = await p.evaluate(() => ({
      hint: document.querySelector("#compress-hint").textContent,
      pressed: [...document.querySelectorAll(".compress-level")].map((b) => b.getAttribute("aria-pressed")),
    }));
    check("Strong presses the pair, hint warns about quality",
      strong.pressed.join() === "false,true"
      && strong.hint === "Rebuilds photos as smaller JPEGs. Image quality goes down a little.",
      JSON.stringify(strong));

    // back to Standard: the demo file is photo pages, so the little-gain
    // copy (not the warning) is the honest result for this run
    await p.click('.compress-level[data-level="standard"]');
    await sleep(150);
    const backStd = await p.evaluate(() => ({
      pressed: [...document.querySelectorAll(".compress-level")].map((b) => b.getAttribute("aria-pressed")),
      hint: document.querySelector("#compress-hint").textContent,
    }));
    check("Standard presses back cleanly",
      backStd.pressed.join() === "true,false"
      && backStd.hint === "Lossless. Rewrites the file without touching how it looks.",
      JSON.stringify(backStd));

    // assignment is photo pages: the little-gain copy is the honest result
    await p.click("#compress-go");
    await p.waitForSelector("#compress-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      status: document.querySelector("#compress-status").textContent,
      link: document.querySelector("#compress-download").getAttribute("download"),
    }));
    check("compress little-gain copy",
      done.status === "Saved 0%. This file is mostly images, so it can't shrink much.",
      done.status);
    check("compress download name", done.link === "assignment-compressed.pdf", done.link);
    await p.close();

    // big save: real text streams squeeze far down, status shows both sizes
    const q = await browser.newPage();
    q.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await q.setViewport({ width: 1440, height: 900 });
    await q.goto("http://127.0.0.1:5000/?theme=light&tool=compress", { waitUntil: "load" });
    const inp = await q.$("#compress-input");
    await inp.uploadFile(path.join(process.cwd(), "samples", "text20.pdf"));
    await settleStrip(q, "compress", 20);
    await goLit(q, "compress");
    await q.click("#compress-go");
    await q.waitForSelector("#compress-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const saved = await q.$eval("#compress-status", (n) => n.textContent);
    check("compress big save copy",
      /^Saved \d+%\. \d+(\.\d+)? KB to \d+(\.\d+)? KB$/.test(saved), saved);
    await q.close();
  }

  /* ---------- 12d. lock: hints, eyes, run, reset ---------- */
  {
    const p = await openTool("lock");
    const begin = await p.evaluate(() => ({
      hint: document.querySelector("#lock-hint").textContent,
      disabled: document.querySelector("#lock-go").disabled,
    }));
    check("lock hint starts with the empty copy",
      begin.hint === "Type the same password twice to lock the copy.", begin.hint);
    check("lock starts disabled", begin.disabled, "");

    await field(p, "#lock-password", "notes");
    await sleep(150);
    const mismatch = await p.evaluate(() => ({
      hint: document.querySelector("#lock-hint").textContent,
      disabled: document.querySelector("#lock-go").disabled,
    }));
    check("mismatch hint", mismatch.hint === "The two passwords don't match yet.",
      mismatch.hint);
    check("go waits for the match", mismatch.disabled, "");

    await field(p, "#lock-confirm", "notes");
    await sleep(150);
    const match = await p.evaluate(() => ({
      hint: document.querySelector("#lock-hint").textContent,
      disabled: document.querySelector("#lock-go").disabled,
    }));
    check("match hint readies the run",
      match.hint === "The passwords match. Locking is ready.", match.hint);
    check("go enables on match", !match.disabled, "");

    await p.click("#lock-eye");
    await sleep(120);
    const shown = await p.evaluate(() => ({
      type: document.querySelector("#lock-password").type,
      icon: document.querySelector("#lock-eye use").getAttribute("href"),
      pressed: document.querySelector("#lock-eye").getAttribute("aria-pressed"),
    }));
    check("eye reveals the password", shown.type === "text"
      && shown.icon === "#i-eye-off" && shown.pressed === "true", JSON.stringify(shown));
    await p.click("#lock-eye");
    await sleep(120);
    const hidden = await p.evaluate(() => ({
      type: document.querySelector("#lock-password").type,
      icon: document.querySelector("#lock-eye use").getAttribute("href"),
    }));
    check("eye hides it again",
      hidden.type === "password" && hidden.icon === "#i-eye", JSON.stringify(hidden));

    await p.click("#lock-go");
    await p.waitForSelector("#lock-download:not([hidden])", { timeout: 30000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      status: document.querySelector("#lock-status").textContent,
      link: document.querySelector("#lock-download").getAttribute("download"),
    }));
    check("lock produces assignment-locked.pdf",
      done.link === "assignment-locked.pdf" && /^3 pages,/.test(done.status),
      JSON.stringify(done));

    await p.click("#lock-reset");
    await sleep(400);
    const reset = await p.evaluate(() => ({
      hint: document.querySelector("#lock-hint").textContent,
      first: document.querySelector("#lock-password").value,
      second: document.querySelector("#lock-confirm").value,
      zoneBack: !document.querySelector("#lock-zone").hidden,
    }));
    check("lock reset returns empty hint + bare zone",
      reset.hint === "Type the same password twice to lock the copy."
      && !reset.first && !reset.second && reset.zoneBack, JSON.stringify(reset));
    await p.close();
  }

  /* ---------- 12e. unlock: hold, wrong, right, not-locked ---------- */
  {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("http://127.0.0.1:5000/?tool=unlock&demo=1", { waitUntil: "load" });
    await p.waitForSelector("#unlock-options:not([hidden])", { timeout: 20000 });
    await sleep(400);
    const held = await p.evaluate(() => ({
      hint: document.querySelector("#unlock-hint").textContent,
      hintShown: !document.querySelector("#unlock-hint").hidden,
      dismissed: document.querySelector("#unlock-notice").hidden,
      lockedSheet: !!document.querySelector("#unlock-strip .strip__sheet.is-locked"),
      labels: [...document.querySelectorAll("#unlock-strip .strip__label")].map((l) => l.textContent),
      canvases: document.querySelectorAll("#unlock-strip .strip__canvas").length,
      goDisabled: document.querySelector("#unlock-go").disabled,
      optionsShown: !document.querySelector("#unlock-options").hidden,
    }));
    check("locked load holds the file (no error shout)",
      held.hintShown && held.dismissed && held.lockedSheet
      && held.canvases === 0 && held.goDisabled && held.optionsShown,
      JSON.stringify(held));
    check("locked hint copy on the shelf",
      held.hint === "This PDF is locked. Enter its password to continue.", held.hint);
    check("locked sheet label", held.labels.join() === "Locked", JSON.stringify(held.labels));

    await field(p, "#unlock-password", "mistake");
    await sleep(150);
    check("any password enables the retry",
      !(await p.$eval("#unlock-go", (b) => b.disabled)), "");
    await p.click("#unlock-go");
    await p.waitForFunction(() => !document.querySelector("#unlock-notice").hidden,
      { timeout: 30000 });
    const wrong = await p.evaluate(() => ({
      notice: document.querySelector("#unlock-notice").textContent,
      optionsShown: !document.querySelector("#unlock-options").hidden,
      hintShown: !document.querySelector("#unlock-hint").hidden,
      stillLocked: !!document.querySelector("#unlock-strip .strip__sheet.is-locked"),
    }));
    check("wrong password exact copy",
      wrong.notice === "That password didn't work. Try again.", wrong.notice);
    check("same file held for the retry",
      wrong.optionsShown && wrong.hintShown && wrong.stillLocked, JSON.stringify(wrong));

    await field(p, "#unlock-password", "notes");
    await sleep(150);
    await p.click("#unlock-go");
    await p.waitForSelector("#unlock-download:not([hidden])", { timeout: 30000 });
    await p.waitForSelector("#unlock-strip .strip__canvas", { timeout: 20000 });
    await sleep(900);
    const done = await p.evaluate(() => ({
      status: document.querySelector("#unlock-status").textContent,
      link: document.querySelector("#unlock-download").getAttribute("download"),
      optionsHidden: document.querySelector("#unlock-options").hidden,
      hintHidden: document.querySelector("#unlock-hint").hidden,
      sheets: document.querySelectorAll("#unlock-strip .strip__canvas").length,
    }));
    check("unlock succeeds with the right password",
      done.link === "locked-unlocked.pdf" && done.optionsHidden && done.hintHidden
      && done.sheets >= 1, JSON.stringify(done));
    check("unlock summary pages", /^1 page,/.test(done.status), done.status);

    // a file that was never locked says so instead of asking for a password
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1440, height: 900 });
    await p2.goto("http://127.0.0.1:5000/?theme=light&tool=unlock", { waitUntil: "load" });
    const inp = await p2.$("#unlock-input");
    await inp.uploadFile(path.join(process.cwd(), "samples", "assignment.pdf"));
    await settleStrip(p2, "unlock", 3);
    await p2.click("#unlock-go");
    await p2.waitForFunction(() => !document.querySelector("#unlock-notice").hidden,
      { timeout: 30000 });
    const plain = await p2.$eval("#unlock-notice", (n) => n.textContent);
    check("not-locked copy",
      plain === "This PDF is not locked. It has no password to remove.", plain);
    await p2.close();
    await p.close();
  }

  /* ---------- 12f. text: panel, copy, scanned, 50-page note ---------- */
  {
    const p = await openTool("text");
    await goLit(p, "text");
    const begin = await p.$eval("#text-details", (n) => n.hidden);
    check("text panel opens empty", begin, "");

    await p.click("#text-go");
    await p.waitForSelector("#text-details:not([hidden])", { timeout: 30000 });
    await sleep(600);
    const panel = await p.evaluate(() => ({
      blocks: document.querySelectorAll("#text-box .textpanel__page").length,
      firstNo: document.querySelector(".textpanel__page .textpanel__pageno")?.textContent,
      firstText: document.querySelector(".textpanel__page .textpanel__text")?.textContent.slice(0, 60),
      copyShown: !document.querySelector("#text-copy").hidden,
      download: document.querySelector("#text-download").getAttribute("download"),
      status: document.querySelector("#text-status").textContent,
      noteHidden: document.querySelector("#text-note").hidden,
      goHidden: document.querySelector("#text-go").hidden,
    }));
    check("reading panel shows every page block",
      panel.blocks === 20 && panel.firstNo === "Page 1", JSON.stringify(panel));
    check("first block carries real words",
      panel.firstText.includes("sheet 1 of 20"), panel.firstText);
    check("copy + txt download appear, go hides",
      panel.copyShown && panel.download === "text20-text.txt" && panel.goHidden,
      JSON.stringify(panel));
    check("text status counts pages", panel.status === "20 pages of text", panel.status);
    check("no note under 50 pages", panel.noteHidden, "");

    await grantClipboard(p);
    await p.click("#text-copy");
    await sleep(300);
    const copied = await p.$eval("#text-copy", (b) => b.textContent);
    check("copy button acknowledges", copied === "Copied", copied);
    await p.close();

    // scanned file: nothing to read, the scan copy is the answer
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1440, height: 900 });
    await p2.goto("http://127.0.0.1:5000/?theme=light&tool=text", { waitUntil: "load" });
    const inp = await p2.$("#text-input");
    await inp.uploadFile(path.join(process.cwd(), "samples", "scanned.pdf"));
    await settleStrip(p2, "text", 3);
    await goLit(p2, "text");
    await p2.click("#text-go");
    await p2.waitForFunction(() => !document.querySelector("#text-notice").hidden,
      { timeout: 30000 });
    const scan = await p2.evaluate(() => ({
      notice: document.querySelector("#text-notice").textContent,
      detailsHidden: document.querySelector("#text-details").hidden,
      copyHidden: document.querySelector("#text-copy").hidden,
    }));
    check("scanned copy is exact",
      scan.notice === "No text found. This PDF looks like a scan, so there is nothing to copy yet.",
      scan.notice);
    check("scan keeps the panel closed",
      scan.detailsHidden && scan.copyHidden, JSON.stringify(scan));
    await p2.close();

    // over 50 pages: the note explains the preview cap
    const p3 = await browser.newPage();
    await p3.setViewport({ width: 1440, height: 900 });
    await p3.goto("http://127.0.0.1:5000/?theme=dark&tool=text", { waitUntil: "load" });
    const inp3 = await p3.$("#text-input");
    await inp3.uploadFile(path.join(process.cwd(), "samples", "big200.pdf"));
    await goLit(p3, "text");
    await p3.click("#text-go");
    await p3.waitForSelector("#text-details:not([hidden])", { timeout: 60000 });
    await sleep(600);
    const big = await p3.evaluate(() => ({
      blocks: document.querySelectorAll("#text-box .textpanel__page").length,
      note: document.querySelector("#text-note").textContent,
      noteShown: !document.querySelector("#text-note").hidden,
      status: document.querySelector("#text-status").textContent,
      download: document.querySelector("#text-download").getAttribute("download"),
    }));
    check("preview caps at 50 blocks", big.blocks === 50, `${big.blocks}`);
    check("cap note copy",
      big.note === "Showing the first 50 of 200 pages. The download has every page.",
      big.note);
    check("status counts all 200", big.status === "200 pages of text", big.status);
    check("txt download takes every page", big.download === "big200-text.txt",
      big.download);
    await p3.close();
  }

  /* ================================================================
     Phase 5: lazy strip, shift-click, states, robustness, a11y
     ================================================================ */

  /* ---------- 14. lazy strip: 200 pages stay smooth ---------- */
  {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("http://127.0.0.1:5000/?theme=light&tool=text", { waitUntil: "load" });
    const inp = await p.$("#text-input");
    await inp.uploadFile(path.join(process.cwd(), "samples", "big200.pdf"));
    await p.waitForFunction(() => (
      document.querySelectorAll("#text-strip .strip__sheet").length === 200
    ), { timeout: 30000 });
    const lazy = await p.evaluate(() => {
      const loading = [...document.querySelectorAll("#text-strip .strip__sheet.is-loading")];
      const canvases = document.querySelectorAll("#text-strip .strip__canvas").length;
      const labels = [...document.querySelectorAll("#text-strip .strip__label")];
      return {
        canvases, loading: loading.length,
        paper: loading.length ? getComputedStyle(loading[0]).backgroundColor : "",
        last: labels[labels.length - 1] ? labels[labels.length - 1].textContent : "",
      };
    });
    check("200-page strip stays lazy (few canvases painted up front)",
      lazy.canvases < 60, JSON.stringify(lazy));
    check("white sheet + page number while a thumbnail loads",
      lazy.loading > 180 && lazy.paper === "rgb(255, 255, 255)" && lazy.last === "200",
      JSON.stringify(lazy));
    await settleStrip(p, "text", 200);
    const painted = await p.evaluate(() =>
      document.querySelectorAll("#text-strip .strip__canvas").length);
    check("sweeping the strip paints every page", painted === 200, `${painted}`);
    await p.close();
  }

  /* ---------- 15. shift-click range + keyboard selection ---------- */
  {
    const p = await openTool("extract");
    await p.focus('#extract-strip .strip__page[data-page="0"]');
    await p.keyboard.press(" ");
    await sleep(200);
    let s = await p.evaluate(() => ({
      pressed: document.querySelector('#extract-strip .strip__page[data-page="0"]')
        .getAttribute("aria-pressed"),
      input: document.querySelector("#extract-pages").value,
    }));
    check("Space on a focused sheet selects it",
      s.pressed === "true" && s.input === "1", JSON.stringify(s));

    await p.keyboard.down("Shift");
    await p.click('#extract-strip .strip__page[data-page="2"]');
    await p.keyboard.up("Shift");
    await sleep(250);
    s = await p.evaluate(() => ({
      input: document.querySelector("#extract-pages").value,
      pressed: [...document.querySelectorAll("#extract-strip .strip__page")]
        .map((n) => n.getAttribute("aria-pressed")),
    }));
    check("shift-click selects the clicked range",
      s.input === "1-" && s.pressed.join() === "true,true,true", JSON.stringify(s));
    await p.close();
  }

  /* ---------- 16. aria-current, label dropzone, progress semantics ---------- */
  {
    const p = await openPanel("extract");
    const a11y = await p.evaluate(() => {
      const current = document.querySelector('.toolindex__item[aria-current="page"]');
      const zone = document.querySelector("#extract-zone");
      const bar = document.querySelector("#extract-progress");
      return {
        current: current ? current.dataset.tool : "",
        zoneTag: zone.tagName,
        zoneInput: Boolean(zone.querySelector("input")),
        barRole: bar.getAttribute("role"),
        barMax: bar.getAttribute("aria-valuemax"),
        barNow: bar.getAttribute("aria-valuenow"),
      };
    });
    check("active tool carries aria-current", a11y.current === "pages", JSON.stringify(a11y));
    check("drop zone is a native label for its file input",
      a11y.zoneTag === "LABEL" && a11y.zoneInput, JSON.stringify(a11y));
    check("progress bar carries progressbar semantics",
      a11y.barRole === "progressbar" && a11y.barMax === "100" && a11y.barNow === "0",
      JSON.stringify(a11y));
    await (await p.$("#extract-input")).focus();
    await sleep(120);
    const ring = await p.$eval("#extract-zone",
      (n) => getComputedStyle(n).outlineStyle);
    check("focus ring shows on the drop zone", ring === "solid", ring);
    await p.close();
  }

  /* ---------- 17. server-down: shouted once, then quiet ---------- */
  {
    const p = await openTool("extract");
    await setRange(p, "#extract-pages", "1,2");
    await goLit(p, "extract");
    await p.setRequestInterception(true);
    let block = true;
    p.on("request", (req) => {
      const dead = req.url().includes("/api/extract") || req.url().includes("/api/delete");
      if (block && dead) req.abort("failed");
      else req.continue();
    });
    await p.click("#extract-go");
    await p.waitForFunction(() => !document.querySelector("#extract-notice").hidden,
      { timeout: 15000 });
    const first = await p.$eval("#extract-notice", (n) => n.textContent);
    check("server-down notice on the first dead request",
      first === "Can't reach the local server. Start it with `python server.py` and refresh.",
      first);
    await p.click("#extract-go");
    await p.waitForFunction(() => (
      document.querySelector("#extract-status").textContent
        .includes("Can't reach the local server.")
    ), { timeout: 15000 });
    const second = await p.evaluate(() => ({
      notice: document.querySelector("#extract-notice").textContent,
      noticeHidden: document.querySelector("#extract-notice").hidden,
      status: document.querySelector("#extract-status").textContent,
    }));
    check("a repeat failure stays quiet (status line, no new shout)",
      second.notice === "" && second.noticeHidden
      && second.status === "Can't reach the local server.",
      JSON.stringify(second));
    // a different tool failing during the SAME outage is also quiet
    await p.evaluate(() => { location.hash = "#/pages/delete"; });
    await p.waitForFunction(() => !document.querySelector("#panel-delete").hidden, { timeout: 5000 });
    const dInput = await p.$("#delete-input");
    await dInput.uploadFile(path.join(process.cwd(), "samples", "assignment.pdf"));
    await p.$eval("#delete-pages", (n) => {
      n.value = "1";
      n.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await goLit(p, "delete");
    await p.click("#delete-go");
    await p.waitForFunction(() => (
      document.querySelector("#delete-status").textContent
        .includes("Can't reach the local server.")
    ), { timeout: 15000 });
    const quiet = await p.evaluate(() => ({
      noticeHidden: document.querySelector("#delete-notice").hidden,
      status: document.querySelector("#delete-status").textContent,
    }));
    check("the outage is shouted once across tools",
      quiet.noticeHidden && quiet.status === "Can't reach the local server.",
      JSON.stringify(quiet));
    // a reply ends the outage: the next extract run succeeds
    block = false;
    await p.evaluate(() => { location.hash = "#/pages/extract"; });
    await p.waitForFunction(() => !document.querySelector("#panel-extract").hidden, { timeout: 5000 });
    await p.click("#extract-go");
    await p.waitForSelector("#extract-download:not([hidden])", { timeout: 30000 });
    check("recovered request ends the episode",
      await p.$eval("#extract-notice", (n) => n.hidden), "");
    await p.close();
  }

  /* ---------- 18. client-side upload limit ---------- */
  {
    const p = await openPanel("extract");
    const gate = await p.evaluate(() => {
      const big = new File([new Uint8Array(101 * 1024 * 1024)], "too-big.pdf",
        { type: "application/pdf" });
      acceptFiles([big], "extract");
      return document.querySelector("#extract-notice").textContent;
    });
    check("over-100 MB upload stops client-side with the friendly copy",
      gate === "This upload is too large. The limit is 100 MB.", gate);
    await p.close();
  }

  /* ---------- 19. filename handling: unicode + very long ---------- */
  {
    const tmpDir = path.join(process.cwd(), ".taste-skill", "tmp-names");
    fs.mkdirSync(tmpDir, { recursive: true });
    const uniPath = path.join(tmpDir, "résumé armor final report v2.pdf");
    fs.copyFileSync(path.join(process.cwd(), "samples", "assignment.pdf"), uniPath);
    const longStem = "assignment " + "x".repeat(150);
    const longPath = path.join(tmpDir, `${longStem}.pdf`);
    fs.copyFileSync(path.join(process.cwd(), "samples", "assignment.pdf"), longPath);

    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("http://127.0.0.1:5000/?theme=light&tool=extract", { waitUntil: "load" });
    const inp = await p.$("#extract-input");
    await inp.uploadFile(uniPath);
    await setRange(p, "#extract-pages", "1,2");
    await goLit(p, "extract");
    await p.click("#extract-go");
    await p.waitForSelector("#extract-download:not([hidden])", { timeout: 30000 });
    const uni = await p.$eval("#extract-download", (n) => n.textContent);
    check("unicode filename survives end to end",
      uni.includes("résumé armor final report v2-extracted.pdf") && !uni.includes("__"),
      uni);
    await p.close();

    const q = await browser.newPage();
    q.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await q.setViewport({ width: 1440, height: 900 });
    await q.goto("http://127.0.0.1:5000/?theme=light&tool=extract", { waitUntil: "load" });
    const inp2 = await q.$("#extract-input");
    await inp2.uploadFile(longPath);
    await setRange(q, "#extract-pages", "1,2");
    await goLit(q, "extract");
    await q.click("#extract-go");
    await q.waitForSelector("#extract-download:not([hidden])", { timeout: 30000 });
    const long = await q.$eval("#extract-download", (n) => n.textContent);
    const bare = long.replace(/^Download /, "").replace(/-extracted\.pdf$/, "");
    check("very long filename is capped, not broken",
      bare.length <= 125 && long.endsWith("-extracted.pdf"), `${bare.length} ${long}`);
    await q.close();
    fs.unlinkSync(uniPath);
    fs.unlinkSync(longPath);
  }

  /* ---------- 20. Start over resets the split mode ---------- */
  {
    const p = await openTool("split");
    await p.click('#split-strip .strip__cut[data-cut="2"]');
    await sleep(200);
    await p.click("#split-go");
    await p.waitForSelector("#split-download:not([hidden])", { timeout: 30000 });
    await p.click("#split-reset");
    await sleep(300);
    const reset = await p.evaluate(() => ({
      mode: (document.querySelector('input[name="split-mode"]:checked') || {}).value,
      hint: document.querySelector("#split-hint").textContent,
      label: document.querySelector("#split-go").textContent,
    }));
    check("Start over resets the split mode",
      reset.mode === "parts" && reset.hint === "Click between two pages to add a cut line."
      && reset.label === "Split PDF", JSON.stringify(reset));
    await p.close();
  }

  /* ---------- 21. responsive: no sideways page scroll, 44px targets ---- */
  {
    for (const w of [360, 390, 768, 1024, 1440]) {
      const p = await browser.newPage();
      await p.setViewport({ width: w, height: 800, isMobile: w < 700 });
      await p.goto("http://127.0.0.1:5000/?theme=light&tool=lock&demo=1", { waitUntil: "load" });
      // The password field only exists once the demo file has loaded.
      await p.waitForSelector("#lock-options:not([hidden])", { timeout: 20000 });
      const sizes = await p.evaluate(() => {
        const h = (sel) => {
          const node = document.querySelector(sel);
          return node ? node.getBoundingClientRect().height : 0;
        };
        return {
          scrollX: document.scrollingElement.scrollWidth,
          inner: window.innerWidth,
          btn: h("#lock-go"),
          icon: h("#theme-toggle"),
          tab: h("#protect-tab-lock"),
          field: h("#lock-password"),
        };
      });
      check(`no horizontal page scroll at ${w}px`,
        sizes.scrollX <= sizes.inner + 1, JSON.stringify(sizes));
      if (w === 390) {
        check("touch targets reach 44px on the phone layout",
          sizes.btn >= 44 && sizes.icon >= 44 && sizes.tab >= 44 && sizes.field >= 44,
          JSON.stringify(sizes));
      }
      await p.close();
    }
  }

  /* ---------- 13. screenshots with real thumbnails ---------- */
  // Wait until every page has rendered (no loading sheets) so prep clicks
  // land on a settled strip - e.g. rotate's angle guard ignores clicks
  // while entry is still loading.
  const settleRotate = (p) => settleStrip(p, "rotate", 3);


  const shot = async (name, url, w, h, prep) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const p = await browser.newPage();
      try {
        // isMobile makes the layout viewport follow the real device width,
        // so the phone media queries apply at 360/390 (headless desktop
        // emulation otherwise lays out at ~960px and scales down).
        await p.setViewport({ width: w, height: h, isMobile: w < 700 });
        await p.goto(url, { waitUntil: "load" });
        try { await p.waitForSelector(".strip__canvas, .strip__img", { timeout: 15000 }); } catch { /* empty state ok */ }
        if (prep) await prep(p);
        await sleep(800);
        await p.screenshot({ path: path.join(SHOTS, name) });
        await p.close();
        return;
      } catch (err) {
        try { await p.close(); } catch { /* already gone */ }
        if (attempt === 1) throw err;
        console.log(`retry shot ${name}: ${String(err.message).split("\n")[0]}`);
        await sleep(600);
      }
    }
  };
  /* Convert queue shots: no demo images - upload a document and wait for
     the file-row queue (strip hidden). */
  const shotQueue = async (name, url, w, h) => {
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h, isMobile: w < 700 });
    await p.goto(url, { waitUntil: "load" });
    const input = await p.$("#to-pdf-input");
    await input.uploadFile(path.join(process.cwd(), "samples", "report.docx"));
    await p.waitForFunction(
      () => document.querySelectorAll("#to-pdf-rows .filerow").length > 0,
      { timeout: 15000 });
    await sleep(800);
    await p.screenshot({ path: path.join(SHOTS, name) });
    await p.close();
  };
  await shot("final-light-demo-1440.png", "http://127.0.0.1:5000/?theme=light&demo=1", 1440, 900);
  await shot("final-light-demo-768.png", "http://127.0.0.1:5000/?theme=light&demo=1", 768, 1000);
  await shot("final-light-demo-390.png", "http://127.0.0.1:5000/?theme=light&demo=1", 390, 900);
  await shot("final-dark-demo-1440.png", "http://127.0.0.1:5000/?demo=1", 1440, 900);
  await shot("final-dark-demo-390.png", "http://127.0.0.1:5000/?demo=1", 390, 900);
  await shot("final-light-info-1440.png", "http://127.0.0.1:5000/?theme=light&tool=info&demo=1", 1440, 900);
  await shot("final-light-1440.png", "http://127.0.0.1:5000/?theme=light", 1440, 900);
  const B = "http://127.0.0.1:5000/?theme=light&tool=";
  const DK = "http://127.0.0.1:5000/?theme=dark&tool=";
  const TQ = `${B}to-pdf`;
  const TDK = `${DK}to-pdf`;
  await shot("final-light-extract-1440.png", `${B}extract&demo=1`, 1440, 900, async (p) => {
    await p.$eval("#extract-pages", (n) => { n.value = "1,3"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await sleep(400);
  });
  await shot("final-light-extract-390.png", `${B}extract&demo=1`, 390, 900, async (p) => {
    await p.click('#extract-strip .strip__page[data-page="0"]');
    await p.$eval("#extract-pages", (n) => { n.value = "1"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await sleep(300);
  });
  await shot("final-light-delete-1440.png", `${B}delete&demo=1`, 1440, 900, async (p) => {
    await settleStrip(p, "delete", 3);
    await p.$eval("#delete-pages", (n) => {
      n.value = "1";
      n.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
  });
  await shot("final-light-split-1440.png", `${B}split&demo=1`, 1440, 900, async (p) => {
    await p.click('#split-strip .strip__cut[data-cut="2"]');
    await sleep(250);
  });
  await shot("final-dark-extract-1440.png", `${DK}extract&demo=1`, 1440, 900, async (p) => {
    await p.click('#extract-strip .strip__page[data-page="1"]');
    await p.$eval("#extract-pages", (n) => { n.value = "1,3"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await sleep(300);
  });
  await shot("final-dark-split-1440.png", `${DK}split&demo=1`, 1440, 900, async (p) => {
    await p.click('#split-strip .strip__cut[data-cut="1"]');
    await sleep(250);
  });
  await shot("final-light-split-390.png", `${B}split&demo=1`, 390, 1100, async (p) => {
    await p.click('#split-strip .strip__cut[data-cut="1"]');
    await sleep(250);
  });
  await shot("final-light-rotate-1440.png", `${B}rotate&demo=1`, 1440, 900, async (p) => {
    await settleRotate(p);
    await p.click('.rot-angle[data-degrees="90"]');
    await sleep(700);
  });
  await shot("final-dark-rotate-1440.png", `${DK}rotate&demo=1`, 1440, 900, async (p) => {
    await settleRotate(p);
    await p.click('.rot-angle[data-degrees="180"]');
    await sleep(700);
  });
  await shot("final-light-rotate-768.png", `${B}rotate&demo=1`, 768, 1000, async (p) => {
    await settleRotate(p);
    await p.click('.rot-angle[data-degrees="270"]');
    await sleep(700);
  });
  // Convert: photo strip (demo images) and document queue + empty states.
  await shot("final-light-topdf-1440.png", `${TQ}&demo=1`, 1440, 900);
  await shot("final-dark-topdf-1440.png", `${TDK}&demo=1`, 1440, 900);
  await shot("final-light-topdf-390.png", `${TQ}&demo=1`, 390, 1000);
  await shot("final-dark-topdf-390.png", `${TDK}&demo=1`, 390, 1000);
  await shotQueue("final-light-topdf-queue-1440.png", TQ, 1440, 900);
  await shotQueue("final-light-topdf-queue-768.png", TQ, 768, 1000);
  await shotQueue("final-light-topdf-queue-390.png", TQ, 390, 1000);
  await shotQueue("final-dark-topdf-queue-1440.png", TDK, 1440, 900);
  await shotQueue("final-dark-topdf-queue-390.png", TDK, 390, 1000);
  await shot("final-light-topdf-empty-1440.png", TQ, 1440, 900);
  await shot("final-dark-topdf-empty-1440.png", TDK, 1440, 900);

  /* ---------- phase 4 gallery ---------- */
  await shot("final-light-compress-1440.png", `${B}compress&demo=1`, 1440, 900,
    async (p) => settleStrip(p, "compress", 3));
  await shot("final-light-compress-768.png", `${B}compress&demo=1`, 768, 1000,
    async (p) => {
      await settleStrip(p, "compress", 3);
      await p.click('.compress-level[data-level="strong"]');
      await sleep(250);
    });
  await shot("final-light-compress-390.png", `${B}compress&demo=1`, 390, 1100,
    async (p) => settleStrip(p, "compress", 3));
  await shot("final-dark-compress-1440.png", `${DK}compress&demo=1`, 1440, 900,
    async (p) => {
      await settleStrip(p, "compress", 3);
      await p.click('.compress-level[data-level="strong"]');
      await sleep(250);
    });

  const lockPrep = async (p, happy) => {
    await settleStrip(p, "lock", 3);
    await field(p, "#lock-password", "notes");
    if (happy) await field(p, "#lock-confirm", "notes");
    await sleep(250);
  };
  await shot("final-light-lock-1440.png", `${B}lock&demo=1`, 1440, 900,
    async (p) => {
      await lockPrep(p, true);
      await p.click("#lock-eye");
      await sleep(150);
    });
  await shot("final-light-lock-768.png", `${B}lock&demo=1`, 768, 1000,
    async (p) => lockPrep(p, true));
  await shot("final-light-lock-390.png", `${B}lock&demo=1`, 390, 1100,
    async (p) => lockPrep(p, false));
  await shot("final-dark-lock-1440.png", `${DK}lock&demo=1`, 1440, 900,
    async (p) => lockPrep(p, true));

  const heldPrep = (p) => p.waitForSelector("#unlock-options:not([hidden])", { timeout: 20000 })
    .then(() => sleep(400));
  await shot("final-light-unlock-1440.png", `${B}unlock&demo=1`, 1440, 900, heldPrep);
  await shot("final-light-unlock-390.png", `${B}unlock&demo=1`, 390, 1100, heldPrep);
  await shot("final-dark-unlock-1440.png", `${DK}unlock&demo=1`, 1440, 900, heldPrep);
  await shot("final-light-unlock-done-1440.png", `${B}unlock`, 1440, 900,
    async (p) => {
      const inp = await p.$("#unlock-input");
      await inp.uploadFile(path.join(process.cwd(), "samples", "locked.pdf"));
      await heldPrep(p);
      await field(p, "#unlock-password", "notes");
      await sleep(150);
      await p.click("#unlock-go");
      await p.waitForSelector("#unlock-download:not([hidden])", { timeout: 30000 });
      await p.waitForSelector("#unlock-strip .strip__canvas", { timeout: 20000 });
      await sleep(800);
    });

  const textPrep = async (p) => {
    await settleStrip(p, "text", 20);
    await goLit(p, "text");
    await p.click("#text-go");
    await p.waitForSelector("#text-details:not([hidden])", { timeout: 30000 });
    await sleep(700);
  };
  await shot("final-light-text-1440.png", `${B}text&demo=1`, 1440, 900, textPrep);
  await shot("final-light-text-768.png", `${B}text&demo=1`, 768, 1100, textPrep);
  await shot("final-dark-text-1440.png", `${DK}text&demo=1`, 1440, 900, textPrep);
  await shot("final-light-text-note-1440.png", `${B}text`, 1440, 900,
    async (p) => {
      const inp = await p.$("#text-input");
      await inp.uploadFile(path.join(process.cwd(), "samples", "big200.pdf"));
      await goLit(p, "text");
      await p.click("#text-go");
      await p.waitForSelector("#text-details:not([hidden])", { timeout: 60000 });
      await sleep(800);
    });

  /* ---------- phase 5 matrix: every tool, light + dark, 1440 + 390 ---- */
  const toolPreps = {
    merge: (p) => settleStrip(p, "merge", 6),
    info: (p) => settleStrip(p, "info", 3),
    split: (p) => settleStrip(p, "split", 3),
    extract: (p) => settleStrip(p, "extract", 3),
    delete: (p) => settleStrip(p, "delete", 3),
    rotate: (p) => settleStrip(p, "rotate", 3),
    compress: (p) => settleStrip(p, "compress", 3),
    lock: (p) => settleStrip(p, "lock", 3),
    unlock: (p) => p.waitForSelector("#unlock-options:not([hidden])", { timeout: 20000 })
      .then(() => sleep(300)),
    text: (p) => settleStrip(p, "text", 20),
    "to-pdf": () => sleep(400),
  };
  for (const tool of ["merge", "info", "split", "extract", "delete", "rotate",
    "compress", "lock", "unlock", "text", "to-pdf"]) {
    for (const theme of ["light", "dark"]) {
      for (const w of [1440, 390]) {
        await shot(`p5-${theme}-${tool}-${w}.png`,
          `http://127.0.0.1:5000/?theme=${theme}&tool=${tool}&demo=1`,
          w, w === 1440 ? 900 : 1100, toolPreps[tool]);
      }
    }
  }

  /* ================================================================
     Phase 6: Shelf home (Ashen Press scene). The shelf is the app's
     home and its only navigation: ten volumes, one per tool. WebGL
     runs on SwiftShader in this Chrome, so every scene timeout here
     is generous on purpose.
     ================================================================ */
  const SHELF_URL = (theme) => `http://127.0.0.1:5000/?theme=${theme}`;
  const HOME_TOOL_IDS = ["merge", "split", "pages", "rotate", "compress",
    "text", "watermark", "protect", "to-pdf", "info"];
  const shelfBooted = (p) => p.waitForFunction(() => {
    const gl = document.querySelector("#shelf-root canvas#gl");
    const loader = document.querySelector("#loader");
    return Boolean(gl && gl.classList.contains("on") && loader && loader.classList.contains("gone"));
  }, { polling: 300, timeout: 60000 });

  // Network + console observers for one page. data:/blob: URLs are not
  // network requests (the scene's painted plates), so only http(s) counts.
  const watchPage = (p) => {
    const ext = []; const noise = []; const hits = [];
    p.on("request", (r) => {
      const u = r.url();
      if (!/^https?:\/\//.test(u)) return;
      if (u.startsWith("http://127.0.0.1:5000")) { hits.push(u); return; }
      ext.push(u);
    });
    p.on("response", (r) => {
      if (r.status() >= 400) noise.push(`http ${r.status()}: ${r.url()}`);
    });
    p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") noise.push(`${m.type()}: ${m.text()}`); });
    p.on("pageerror", (e) => noise.push(`pageerror: ${e.message}`));
    return { ext, noise, hits };
  };

  const shotShelf = async (name, theme, w, h) => {
    const p = await browser.newPage();
    try {
      await p.setViewport({ width: w, height: h, isMobile: w < 700, hasTouch: w < 700 });
      await p.goto(SHELF_URL(theme), { waitUntil: "load" });
      await shelfBooted(p);
      await sleep(2600); // let the authored intro settle
      await p.screenshot({ path: path.join(SHOTS, name) });
    } finally { await p.close(); }
  };

  const heapOf = (p) => p.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1));
  // Collect before sampling when the flag took effect; the sleep lets any
  // finalizers settle. Without window.gc the min-of-window comparison in
  // the check below is the honest fallback.
  const sampleHeap = async (p) => {
    await p.evaluate(() => { if (window.gc) { window.gc(); window.gc(); } });
    await sleep(250);
    return heapOf(p);
  };
  const kbdIndex = (p) => p.evaluate(() =>
    [...document.querySelectorAll("#tl .tli")].findIndex((el) => el.classList.contains("kbd")));

  // --- startup load: three.js arrives at boot, then pause/resume -------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    check("shelf home: three.js loads at startup, behind the shell",
      w.hits.some((u) => u.includes("/static/vendor/three.module.js")),
      w.hits.filter((u) => u.includes("three") || u.includes("shelf")).join(", "));
    check("shelf home: load makes no request outside 127.0.0.1", w.ext.length === 0, w.ext.join(" | "));
    // opening a tool pauses the loop; the canvas stays in place
    await p.evaluate(() => { location.hash = "#/merge"; });
    await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
    await sleep(400);
    const s1 = await p.evaluate(() => ({
      ...window.__SHELF__(),
      home: document.getElementById("view-home").hidden,
      canvases: document.querySelectorAll("#shelf-root canvas#gl").length,
      glClass: document.querySelector("#shelf-root canvas#gl").className,
    }));
    check("shelf pause: opening a tool stops the loop, scene stays in memory",
      s1.live && s1.paused && s1.home && s1.canvases === 1 && s1.glClass.includes("on"), JSON.stringify(s1));
    await p.evaluate(() => { location.hash = "#/"; });
    await p.waitForFunction(() => !document.getElementById("view-home").hidden, { timeout: 5000 });
    await sleep(400);
    const s2 = await p.evaluate(() => ({ ...window.__SHELF__(), loaderGone: document.getElementById("loader").classList.contains("gone") }));
    check("shelf resume: back home the loop runs again, loader stays gone",
      s2.live && !s2.paused && s2.loaderGone, JSON.stringify(s2));
    check("shelf startup: console stays clean", w.noise.length === 0, w.noise.join(" | "));
    await p.close();
  }

  // --- boot state + keyboard + pointer, one long light visit ----------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    await sleep(2800); // authored intro settles
    const s = await p.evaluate(() => {
      const stage = document.getElementById("shelf-stage");
      const gl = document.querySelector("#shelf-root canvas#gl");
      return {
        tli: document.querySelectorAll("#tl .tli").length,
        links: document.querySelectorAll("#toolindex a.toolindex__item").length,
        indexHidden: document.getElementById("toolindex").classList.contains("wb__sr"),
        aria: gl.getAttribute("aria-label") || "",
        sized: gl.width === stage.clientWidth && gl.height === stage.clientHeight,
        note: document.getElementById("toolindex-note").hidden,
        home: !document.getElementById("view-home").hidden,
        title: document.title,
        shelf: (() => { try { return window.__SHELF__(); } catch { return null; } })(),
        riseIn: document.querySelectorAll("#shelf-root .rise.in").length,
      };
    });
    check("shelf boots: catalogue strip has 10 volumes", s.tli === 10, String(s.tli));
    check("shelf boots: canvas fills the frame exactly", s.sized, "canvas size != stage size");
    check("shelf boots: canvas has the described aria-label", s.aria.startsWith("Folio tool shelf"), s.aria.slice(0, 60));
    check("shelf boots: hidden accessible list carries the 10 tools",
      s.links === 10 && s.indexHidden, `links=${s.links} hidden=${s.indexHidden}`);
    check("shelf boots: home is the default view with the plain title",
      s.home && s.title === "Folio", `${s.home} "${s.title}"`);
    check("shelf boots: scene live (debug hook)", Boolean(s.shelf && s.shelf.live), JSON.stringify(s.shelf));
    check("shelf boots: no fallback note", s.note === true, "");
    check("shelf boots: intro chrome revealed", s.riseIn > 0, String(s.riseIn));

    const ring = await p.evaluate(() => {
      const gl = document.querySelector("#shelf-root canvas#gl");
      gl.focus();
      return getComputedStyle(gl).outlineStyle;
    });
    check("shelf a11y: visible focus ring on the scene", ring !== "none", ring);

    await p.focus("#shelf-root canvas#gl");
    await p.keyboard.press("ArrowRight"); await sleep(300);
    let idx = await kbdIndex(p);
    check("shelf keyboard: ArrowRight reaches volume I", idx === 0, String(idx));
    await p.keyboard.press("ArrowDown"); await sleep(300);
    idx = await kbdIndex(p);
    check("shelf keyboard: ArrowDown moves 5 (volume VI)", idx === 5, String(idx));
    await p.keyboard.press("ArrowUp"); await sleep(300);
    idx = await kbdIndex(p);
    check("shelf keyboard: ArrowUp moves back 5", idx === 0, String(idx));
    await p.keyboard.press("ArrowLeft"); await sleep(300);
    idx = await kbdIndex(p);
    check("shelf keyboard: ArrowLeft clamps at volume I", idx === 0, String(idx));

    await p.keyboard.press("Enter"); await sleep(900);
    const d1 = await p.evaluate(() => ({
      on: document.getElementById("detail").classList.contains("on"),
      title: document.getElementById("detail-title").textContent,
    }));
    check("shelf keyboard: Enter takes the volume down", d1.on && d1.title.length > 0, `on=${d1.on} title="${d1.title}"`);
    await p.keyboard.press("Escape"); await sleep(1250); // back-animation is 700ms + timer
    const d2 = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
    check("shelf keyboard: Escape puts it back", d2 === false, String(d2));
    await p.keyboard.press("Enter"); await sleep(900);
    const d3 = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
    check("shelf keyboard: Enter reopens after Escape", d3 === true, String(d3));
    await p.keyboard.press("Space"); await sleep(500);
    const d4 = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
    check("shelf keyboard: Space flips while open, panel stays", d4 === true, String(d4));
    await p.keyboard.press("Escape"); await sleep(700);

    // Hovering a resting volume lifts it (pointer cursor). The authored
    // "Drag to turn" hint belongs to the OPEN volume: the move-cast tests
    // the invisible shelf proxies, so the hint appears over the slot the
    // volume came from (the orbit is damped while a volume is out, which
    // parks that slot left of its resting spot).
    const stageBox = await p.evaluate(() => {
      const r = document.getElementById("shelf-stage").getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    const at = (fx, fy) => ({ x: stageBox.left + stageBox.w * fx, y: stageBox.top + stageBox.h * fy });
    const rest = at(0.55, 0.26);
    await p.mouse.move(rest.x, rest.y, { steps: 8 });
    await sleep(500);
    const cur = await p.evaluate(() => document.body.style.cursor);
    check("shelf pointer: hovering a resting volume lifts it", cur === "pointer", `cursor "${cur}"`);
    await p.keyboard.press("Enter"); // KB.i is still volume I
    await sleep(1400); // take-down animation
    let hintSeen = false;
    for (const [fx, fy] of [[0.24, 0.3], [0.24, 0.22], [0.24, 0.44], [0.36, 0.3]]) {
      const q = at(fx, fy);
      await p.mouse.move(q.x, q.y, { steps: 4 });
      await sleep(280);
      const st = await p.evaluate(() => ({
        hint: document.getElementById("hint").classList.contains("on"),
        cur: document.body.style.cursor,
      }));
      if (st.hint && st.cur === "grab") { hintSeen = true; break; }
    }
    check("shelf pointer: the open volume offers the drag hint", hintSeen, "no slot showed the hint");

    // Dragging grips the floating volume itself (the authored down-cast
    // tests the real body mesh, not the shelf proxy); a miss puts the
    // volume back, so each failed candidate re-opens it and tries on.
    const tryDrag = async (q) => {
      await p.mouse.down();
      await sleep(300);
      const grabbing = await p.evaluate(() => document.body.style.cursor === "grabbing");
      if (!grabbing) { await p.mouse.up(); await sleep(1500); return false; }
      await p.mouse.move(q.x + 90, q.y - 16, { steps: 6 });
      await p.mouse.up();
      await sleep(500);
      return true;
    };
    let dragged = false;
    for (const [fx, fy] of [[0.62, 0.5], [0.72, 0.5], [0.5, 0.5]]) {
      const q = at(fx, fy);
      await p.mouse.move(q.x, q.y, { steps: 4 });
      await sleep(350);
      if (await tryDrag(q)) { dragged = true; break; }
      await p.keyboard.press("Enter"); // the miss returned it to the shelf
      await sleep(1400);
    }
    check("shelf pointer: drag turns the open volume", dragged, "no candidate gripped");
    const stillOn = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
    check("shelf pointer: drag gesture keeps the scene alive", stillOn === true, "detail lost");
    // "Open <Tool>" in the detail panel routes to the tool view.
    // 1300ms: the back-animation clears S.anim at 720ms, so Enter only
    // takes the volume down once it is settled (the keyboard section
    // below uses the same margin).
    await p.keyboard.press("Escape");
    await sleep(1300);
    await p.keyboard.press("Enter"); await sleep(1000); // take the volume down again
    const lookLabel = await p.$eval("#detail-look", (n) => n.textContent);
    const detailOn = await p.$eval("#detail", (n) => n.classList.contains("on"));
    check("shelf detail: the button offers the tool",
      detailOn && lookLabel === "Open Merge", `on=${detailOn} label="${lookLabel}"`);
    await p.click("#detail-look");
    await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
    const opened = await p.evaluate(() => ({
      hash: location.hash,
      panel: !document.getElementById("panel-merge").hidden,
      crumb: document.getElementById("tool-title").textContent,
      title: document.title,
    }));
    check("shelf detail: Open Merge routes to the merge tool",
      opened.hash === "#/merge" && opened.panel && opened.crumb === "Merge PDFs"
      && opened.title === "Folio — Merge PDFs", JSON.stringify(opened));
    await p.goBack();
    await p.waitForFunction(() => !document.getElementById("view-home").hidden, { timeout: 5000 });
    await sleep(400);
    const backState = await p.evaluate(() => ({ ...window.__SHELF__() }));
    check("shelf detail: browser Back returns to the shelf, scene resumes",
      backState.live && !backState.paused, JSON.stringify(backState));
    check("shelf visit: zero console errors/warnings", w.noise.length === 0, w.noise.join(" | "));
    check("shelf visit: zero requests outside 127.0.0.1", w.ext.length === 0, w.ext.join(" | "));
    await p.close();
  }

  // --- DPR cap 2 ------------------------------------------------------
  {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 3 });
    await p.goto(SHELF_URL("dark"), { waitUntil: "load" });
    await shelfBooted(p);
    const cap = await p.evaluate(() => {
      const gl = document.querySelector("#shelf-root canvas#gl");
      const stage = document.getElementById("shelf-stage");
      return gl.width / Math.max(1, stage.clientWidth);
    });
    check("shelf render: devicePixelRatio capped at 2", cap <= 2.02, `ratio ${cap.toFixed(2)}`);
    await p.close();
  }

  // --- 10 open/close cycles, heap watch --------------------------------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    await sleep(500);
    const heap = [await sampleHeap(p)];
    for (let i = 0; i < 10; i += 1) {
      await p.evaluate(() => { location.hash = "#/merge"; });
      await sleep(450);
      heap.push(await sampleHeap(p));
      await p.evaluate(() => { location.hash = "#/"; });
      await shelfBooted(p);
      await sleep(300);
    }
    await p.evaluate(() => { location.hash = "#/merge"; });
    await sleep(450);
    heap.push(await sampleHeap(p));
    const minOf = (a) => Math.min(...a);
    const base = minOf(heap.slice(0, 3));
    const end = minOf(heap.slice(-3));
    const delta = end - base;
    check("shelf memory: no growth after 10 open/close cycles", delta < 15e6,
      `delta ${(delta / 1e6).toFixed(1)} MB (min of last 3 vs first 3); series MB ${heap.map((h) => (h / 1e6).toFixed(0)).join(",")}`);
    const canv = await p.evaluate(() => ({
      n: document.querySelectorAll("#shelf-root canvas#gl").length,
      loaderGone: document.getElementById("loader").classList.contains("gone"),
      state: window.__SHELF__(),
    }));
    check("shelf memory: single canvas, no loader replay after 10 cycles",
      canv.n === 1 && canv.loaderGone, JSON.stringify(canv));
    check("shelf memory: cycles make no external requests", w.ext.length === 0, w.ext.join(" | "));
    check("shelf memory: cycles stay console-clean", w.noise.length === 0, w.noise.join(" | "));
    await p.close();
  }

  // --- ten volumes, ten tools: every cover opens its own view ----------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    await sleep(2600); // intro settles
    for (let i = 0; i < HOME_TOOL_IDS.length; i += 1) {
      const tool = HOME_TOOL_IDS[i];
      // a return trip leaves the volume out and the panel open; close it first
      const detailOn = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
      if (detailOn) {
        await p.click("#detail-close");
        await sleep(1300);
      }
      await p.click(`#tl .tli:nth-child(${i + 1})`);
      await p.waitForFunction(() => document.getElementById("detail").classList.contains("on"),
        { timeout: 8000 });
      await sleep(300);
      const vol = await p.evaluate(() => document.getElementById("detail-title").textContent);
      await p.click("#detail-look");
      await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
      await sleep(250);
      const t = await p.evaluate((id) => ({
        hash: location.hash,
        panel: !document.getElementById(`panel-${id}`).hidden,
        crumb: document.getElementById("tool-title").textContent,
      }), tool);
      check(`book ${i + 1} (${vol}) opens the ${tool} tool`,
        t.hash === `#/${tool}` && t.panel && t.crumb.length > 0, JSON.stringify({ vol, ...t }));
      await p.evaluate(() => { location.hash = "#/"; });
      await p.waitForFunction(() => !document.getElementById("view-home").hidden, { timeout: 5000 });
      await sleep(350);
    }
    check("volume tour: no external requests", w.ext.length === 0, w.ext.join(" | "));
    check("volume tour: console stays clean", w.noise.length === 0, w.noise.join(" | "));
    await p.close();
  }

  // --- protect: one view, two tabs; wordmark and Shelf button return ----
  {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    // deep link straight to the unlock tab
    await p.evaluate(() => { location.hash = "#/protect/unlock"; });
    await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
    const deep = await p.evaluate(() => ({
      unlock: !document.getElementById("panel-unlock").hidden,
      lock: document.getElementById("panel-lock").hidden,
      tab: document.getElementById("protect-tab-unlock").getAttribute("aria-selected"),
    }));
    check("protect: #/protect/unlock opens the Unlock tab",
      deep.unlock && deep.lock && deep.tab === "true", JSON.stringify(deep));
    // tab switch inside the view (hash stays on #/protect)
    await p.evaluate(() => { location.hash = "#/protect"; });
    await sleep(350);
    await p.click("#protect-tab-lock");
    await sleep(250);
    const locked = await p.evaluate(() => ({
      lock: !document.getElementById("panel-lock").hidden,
      unlock: document.getElementById("panel-unlock").hidden,
      sel: document.getElementById("protect-tab-lock").getAttribute("aria-selected"),
    }));
    check("protect: tab switch shows Lock and hides Unlock",
      locked.lock && locked.unlock && locked.sel === "true", JSON.stringify(locked));
    // arrow keys move between tabs (roving tabindex)
    await p.focus("#protect-tab-lock");
    await p.keyboard.press("ArrowRight");
    await sleep(200);
    const rove = await p.evaluate(() => ({
      focused: document.activeElement.id,
      unlock: !document.getElementById("panel-unlock").hidden,
    }));
    check("protect: ArrowRight moves to the Unlock tab",
      rove.focused === "protect-tab-unlock" && rove.unlock, JSON.stringify(rove));
    // the wordmark returns to the shelf
    await p.click("#brand-home");
    await p.waitForFunction(() => !document.getElementById("view-home").hidden, { timeout: 5000 });
    const home1 = await p.evaluate(() => ({ hash: location.hash, shelf: window.__SHELF__() }));
    check("protect: the wordmark returns to the shelf, scene resumes",
      (home1.hash === "" || home1.hash === "#/") && home1.shelf.live && !home1.shelf.paused, JSON.stringify(home1));
    // ...and the Shelf button from a tool does the same
    await p.evaluate(() => { location.hash = "#/text"; });
    await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
    await p.click("#shelf-btn");
    await p.waitForFunction(() => !document.getElementById("view-home").hidden, { timeout: 5000 });
    const home2 = await p.evaluate(() => ({ hash: location.hash, home: !document.getElementById("view-home").hidden }));
    check("protect: the Shelf button returns home from a tool",
      home2.home && (home2.hash === "" || home2.hash === "#/"), JSON.stringify(home2));
    await p.close();
  }

  /* ================================================================
     Phase 6: Watermark and Text > Edit. Both work on a copy: the
     file the user handed over must still hash like the original
     after runs, and a deleted line must be gone when the saved file
     is read back through Text > Read.
     ================================================================ */

  // --- watermark: stamp text, live preview, tiled, range, image ------
  {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("http://127.0.0.1:5000/?tool=watermark&demo=1", { waitUntil: "load" });
    await p.waitForSelector("#watermark-strip .strip__canvas", { timeout: 20000 });
    await sleep(900);
    const wm0 = await p.evaluate(() => ({
      hash: location.hash,
      canvases: document.querySelectorAll("#watermark-strip .strip__canvas").length,
      fonts: document.querySelector("#watermark-font").options.length,
      angle: document.querySelector("#watermark-angle").value,
      opacity: document.querySelector("#watermark-opacity").value,
      opacityHint: document.querySelector("#watermark-opacity-hint").textContent,
      go: document.querySelector("#watermark-go").disabled,
    }));
    check("watermark: route, strip, six fonts, angle 45, opacity 20",
      wm0.hash === "#/watermark" && wm0.canvases === 3 && wm0.fonts === 6
      && wm0.angle === "45" && wm0.opacity === "20" && wm0.opacityHint === "20%"
      && wm0.go, JSON.stringify(wm0));

    await field(p, "#watermark-text", "DRAFT COPY");
    await sleep(300);
    const wmReady = await p.evaluate(() => {
      const first = document.querySelector("#watermark-strip .wm-preview");
      const stamp = document.querySelector("#watermark-strip .wm-preview__text");
      return {
        enabled: !document.querySelector("#watermark-go").disabled,
        previews: document.querySelectorAll("#watermark-strip .wm-preview").length,
        stamps: document.querySelectorAll("#watermark-strip .wm-preview__text").length,
        opacity: first ? first.style.opacity : "",
        rotate: stamp ? stamp.style.transform : "",
      };
    });
    check("watermark: go lights and the live preview paints",
      wmReady.enabled && wmReady.previews === 3 && wmReady.stamps >= 3
      && wmReady.opacity === "0.2" && wmReady.rotate.includes("rotate"),
      JSON.stringify(wmReady));

    await p.click('.wm-position[data-position="tiled"]');
    await setRange(p, "#watermark-pages", "1,3");
    await sleep(400);
    const wmTiled = await p.evaluate(() =>
      [...document.querySelectorAll("#watermark-strip .strip__page")].map(
        (n) => n.querySelectorAll(".wm-preview__text").length));
    check("watermark: tiled preview follows the pages range",
      wmTiled.length === 3 && wmTiled[0] > 0 && wmTiled[1] === 0 && wmTiled[2] > 0,
      JSON.stringify(wmTiled));

    await p.click("#watermark-go");
    await p.waitForSelector("#watermark-download:not([hidden])", { timeout: 30000 });
    const wmDone = await p.evaluate(() =>
      document.querySelector("#watermark-download").getAttribute("download"));
    check("watermark: tiled text run saves a download",
      wmDone === "assignment-watermarked.pdf", wmDone);

    await p.click("#watermark-reset");
    await sleep(600);
    const wmReset = await p.evaluate(() => ({
      zone: !document.querySelector("#watermark-zone").hidden,
      text: document.querySelector("#watermark-text").value,
      centre: document.querySelector('.wm-position[data-position="centre"]').getAttribute("aria-pressed"),
    }));
    check("watermark: Start over clears the form",
      wmReset.zone && wmReset.text === "" && wmReset.centre === "true", JSON.stringify(wmReset));

    // image kind: fields swap, logo preview, behind, then a run
    await p.$eval('input[name="watermark-kind"][value="image"]', (el) => {
      el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const wmImg = await p.evaluate(() => ({
      text: document.querySelector("#watermark-text-field").hidden,
      image: !document.querySelector("#watermark-image-field").hidden,
      scale: !document.querySelector("#watermark-scale-field").hidden,
      behind: Boolean(document.querySelector("#watermark-behind")),
    }));
    check("watermark: image kind swaps the fields, behind stays",
      wmImg.text && wmImg.image && wmImg.scale && wmImg.behind, JSON.stringify(wmImg));
    await (await p.$("#watermark-input")).uploadFile(
      path.join(process.cwd(), "samples", "assignment.pdf"));
    await p.waitForSelector("#watermark-strip .strip__canvas", { timeout: 20000 });
    await sleep(800);
    await (await p.$("#watermark-image")).uploadFile(
      path.join(process.cwd(), "samples", "watermark-logo.png"));
    await sleep(900);
    const imgReady = await p.evaluate(() => ({
      enabled: !document.querySelector("#watermark-go").disabled,
      imgs: document.querySelectorAll("#watermark-strip .wm-preview__item").length,
    }));
    check("watermark: image preview paints and go lights",
      imgReady.enabled && imgReady.imgs >= 3, JSON.stringify(imgReady));
    await p.click("#watermark-behind");
    await p.click("#watermark-go");
    await p.waitForSelector("#watermark-download:not([hidden])", { timeout: 30000 });
    const imgDone = await p.evaluate(() =>
      document.querySelector("#watermark-download").getAttribute("download"));
    check("watermark: image run with behind saves a download",
      imgDone === "assignment-watermarked.pdf", imgDone);
    // the file in the tool still hashes like samples/assignment.pdf
    const entryDigest = await p.evaluate(async () => {
      const buf = await toolState("watermark").entry.file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
    const sampleDigest = createHash("sha256")
      .update(fs.readFileSync(path.join(process.cwd(), "samples", "assignment.pdf")))
      .digest("hex");
    check("watermark: the uploaded file is untouched (same digest)",
      entryDigest === sampleDigest, `${entryDigest.slice(0, 12)} vs ${sampleDigest.slice(0, 12)}`);
    await p.close();
  }

  // --- text > edit: spans, panel, queue, undo, save, read-back -------
  {
    const p = await browser.newPage();
    p.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("http://127.0.0.1:5000/?tool=edit&demo=1", { waitUntil: "load" });
    await p.waitForSelector("#edit-stage:not([hidden])", { timeout: 30000 });
    await p.waitForSelector("#edit-overlay .edit-span", { timeout: 20000 });
    await sleep(400);
    const ed0 = await p.evaluate(() => ({
      hash: location.hash,
      read: document.querySelector("#text-tab-read").getAttribute("aria-selected"),
      edit: document.querySelector("#text-tab-edit").getAttribute("aria-selected"),
      spans: document.querySelectorAll("#edit-overlay .edit-span").length,
      pages: document.querySelectorAll("#edit-strip .strip__canvas").length,
    }));
    check("edit: deep link opens the Edit tab over the demo file",
      ed0.hash === "#/text/edit" && ed0.read === "false" && ed0.edit === "true"
      && ed0.spans > 2 && ed0.pages === 2, JSON.stringify(ed0));

    await p.evaluate(() => {
      [...document.querySelectorAll("#edit-overlay .edit-span")]
        .find((b) => (b.title || "").includes("apparatus")).click();
    });
    await sleep(200);
    const panel = await p.evaluate(() => ({
      shown: !document.querySelector("#edit-panel").hidden,
      text: document.querySelector("#edit-text").value,
      font: document.querySelector("#edit-font").value,
      size: Number(document.querySelector("#edit-size").value),
    }));
    check("edit: clicking a span fills the panel (font matched, size kept)",
      panel.shown && panel.text.includes("apparatus") && panel.font === "times"
      && panel.size > 0, JSON.stringify(panel));

    await field(p, "#edit-text", "the kit was calibrated");
    await p.click("#edit-apply");
    await sleep(250);
    const q1 = await p.evaluate(() => ({
      rows: document.querySelectorAll("#edit-queue .edit-queue__item").length,
      label: document.querySelector("#edit-queue .edit-queue__text").textContent,
      edited: document.querySelectorAll("#edit-overlay .edit-span.is-edited").length,
      save: !document.querySelector("#edit-save").disabled,
    }));
    check("edit: Apply queues the change",
      q1.rows === 1 && q1.label.includes("becomes") && q1.edited === 1 && q1.save,
      JSON.stringify(q1));

    // undo strikes the row and stops the save; redo brings it back
    await p.click("#edit-queue .edit-queue__item:first-child .edit-queue__btn");
    await sleep(200);
    const q2 = await p.evaluate(() => ({
      undone: document.querySelector("#edit-queue .edit-queue__item").classList.contains("is-undone"),
      saveDisabled: document.querySelector("#edit-save").disabled,
    }));
    check("edit: Undo strikes the row and disables Save",
      q2.undone && q2.saveDisabled, JSON.stringify(q2));
    await p.click("#edit-queue .edit-queue__item:first-child .edit-queue__btn:nth-child(2)");
    await sleep(200);
    const q3 = await p.evaluate(() => ({
      redone: !document.querySelector("#edit-queue .edit-queue__item").classList.contains("is-undone"),
      save: !document.querySelector("#edit-save").disabled,
    }));
    check("edit: Redo restores the row and Save", q3.redone && q3.save, JSON.stringify(q3));

    // delete the shortest remaining line (the page footer), leaving the
    // body sentences intact for the read-back witness
    const delText = await p.evaluate(() => {
      const spans = [...document.querySelectorAll("#edit-overlay .edit-span")]
        .filter((b) => !b.classList.contains("is-edited"));
      const shortest = spans.reduce((a, b) => (b.title.length < a.title.length ? b : a));
      shortest.click();
      return shortest.title;
    });
    await sleep(200);
    await p.click("#edit-del");
    await sleep(250);
    const delState = await p.evaluate(() => ({
      deleted: document.querySelectorAll("#edit-overlay .edit-span.is-deleted").length,
      label: document.querySelector("#edit-queue .edit-queue__item:last-child .edit-queue__text").textContent,
    }));
    check("edit: Delete queues the line",
      delState.deleted === 1 && delState.label.includes("delete") && delText.length > 10,
      JSON.stringify({ delText, ...delState }));

    const sizeText = await p.evaluate(() => {
      const spans = [...document.querySelectorAll("#edit-overlay .edit-span")]
        .filter((b) => !b.classList.contains("is-edited")
          && !b.classList.contains("is-deleted"));
      const target = spans.reduce((a, b) => (b.title.length > a.title.length ? b : a));
      target.click();
      return target.title;
    });
    await sleep(200);
    await field(p, "#edit-size", "14");
    await p.click("#edit-apply");
    await sleep(250);
    const sizeQueued = await p.evaluate(() =>
      document.querySelectorAll("#edit-queue .edit-queue__item").length);
    check("edit: a size-only change queues alongside the rest",
      sizeQueued === 3 && sizeText.length > 10, `rows=${sizeQueued}`);

    // add text: Add, then a click on empty paper (dispatched in-page with
    // real coordinates: a mouse click here races the scrolled viewport)
    await p.click("#edit-add");
    await sleep(150);
    const placing = await p.evaluate(() => ({
      pressed: document.querySelector("#edit-add").getAttribute("aria-pressed"),
      cursor: getComputedStyle(document.querySelector("#edit-canvasbox")).cursor,
    }));
    check("edit: Add arms the crosshair", placing.pressed === "true"
      && placing.cursor === "crosshair", JSON.stringify(placing));
    await p.evaluate(() => {
      const box = document.querySelector("#edit-canvasbox");
      const r = box.getBoundingClientRect();
      box.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width * 0.72,
        clientY: r.top + r.height * 0.82,
      }));
    });
    await sleep(250);
    const draft = await p.evaluate(() => ({
      draftBox: document.querySelectorAll("#edit-overlay .edit-span.is-draft").length,
      panelShown: !document.querySelector("#edit-panel").hidden,
      title: document.querySelector("#edit-panel-title").textContent,
    }));
    check("edit: a click on empty paper drops the draft box",
      draft.draftBox === 1 && draft.panelShown && draft.title === "New text",
      JSON.stringify(draft));
    await field(p, "#edit-text", "Added by the drive tour");
    await p.click("#edit-apply");
    await sleep(250);
    const addState = await p.evaluate(() => ({
      rows: document.querySelectorAll("#edit-queue .edit-queue__item").length,
      newBoxes: document.querySelectorAll("#edit-overlay .edit-span.is-new").length,
    }));
    check("edit: the added text queues as new", addState.rows === 4 && addState.newBoxes === 1,
      JSON.stringify(addState));

    await p.click("#edit-save");
    await p.waitForSelector("#edit-download:not([hidden])", { timeout: 30000 });
    const savedName = await p.evaluate(() =>
      document.querySelector("#edit-download").getAttribute("download"));
    check("edit: Save writes the edited copy",
      savedName === "word-export-edited.pdf", savedName);

    // read the saved file back through Text > Read: the deleted line is
    // gone, the change and the untouched words are all there
    const editedHref = await p.$eval("#edit-download", (a) => a.href);
    const bytes = await p.evaluate(async (h) => {
      const r = await fetch(h);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, editedHref);
    const editedPath = path.join(process.cwd(), "temp", "p6-edited.pdf");
    fs.writeFileSync(editedPath, Buffer.from(bytes));
    const norm = (s) => s.replace(/\s+/g, " ");
    const delNorm = norm(delText).trim();
    const sizeNorm = norm(sizeText).trim();
    const r = await browser.newPage();
    await r.setViewport({ width: 1440, height: 900 });
    await r.goto("http://127.0.0.1:5000/?theme=light&tool=text", { waitUntil: "load" });
    await (await r.$("#text-input")).uploadFile(editedPath);
    await goLit(r, "text");
    await r.click("#text-go");
    await r.waitForSelector("#text-details:not([hidden])", { timeout: 30000 });
    await sleep(600);
    const readBack = await r.evaluate(() => {
      const pages = [...document.querySelectorAll("#text-box .textpanel__page")];
      return pages.map((n) => n.querySelector(".textpanel__text").textContent).join("\n");
    });
    const flat = norm(readBack);
    check("edit: the saved file carries the change and keeps the rest",
      flat.includes("the kit was calibrated") && flat.includes("Conductivity")
      && flat.includes(sizeNorm) && !flat.includes("apparatus was calibrated"),
      JSON.stringify({ hasNew: flat.includes("the kit was calibrated"),
        kept: flat.includes("Conductivity"), sizeKept: flat.includes(sizeNorm),
        oldGone: !flat.includes("apparatus was calibrated") }));
    check("edit: the deleted line is truly gone from the saved file",
      !flat.includes(delNorm), `searched for "${delNorm.slice(0, 60)}"`);
    fs.unlinkSync(editedPath);
    await r.close();
    await p.close();

    // scanned + locked files explain themselves on the Edit tab
    const s = await browser.newPage();
    s.on("pageerror", (err) => console.log("PAGE-ERROR:", err.message));
    await s.setViewport({ width: 1440, height: 900 });
    await s.goto("http://127.0.0.1:5000/#/text/edit", { waitUntil: "load" });
    await s.waitForSelector("#edit-input", { timeout: 15000 });
    await (await s.$("#edit-input")).uploadFile(path.join(process.cwd(), "samples", "scanned.pdf"));
    await s.waitForFunction(() => !document.querySelector("#edit-notice").hidden,
      { timeout: 30000 });
    const scanMsg = await s.$eval("#edit-notice", (n) => n.textContent);
    check("edit: a scan explains there is nothing to edit",
      scanMsg === "No editable text found. This PDF looks like a scan.", scanMsg);

    await (await s.$("#edit-input")).uploadFile(
      path.join(process.cwd(), "samples", "locked-text.pdf"));
    await s.waitForSelector("#edit-password-options:not([hidden])", { timeout: 30000 });
    const heldHint = await s.$eval("#edit-password-hint", (n) => n.textContent);
    check("edit: a locked file asks for its password",
      heldHint === "This PDF is locked. Enter its password to continue.", heldHint);
    await field(s, "#edit-password", "mistake");
    await s.click("#edit-unlock");
    await s.waitForFunction(() => !document.querySelector("#edit-notice").hidden,
      { timeout: 30000 });
    const wrong = await s.$eval("#edit-notice", (n) => n.textContent);
    check("edit: wrong password copy",
      wrong === "That password didn't work. Try again.", wrong);
    await field(s, "#edit-password", "notes");
    await s.click("#edit-unlock");
    await s.waitForSelector("#edit-stage:not([hidden])", { timeout: 30000 });
    await s.waitForSelector("#edit-overlay .edit-span", { timeout: 20000 });
    const opened = await s.evaluate(() =>
      document.querySelectorAll("#edit-overlay .edit-span").length);
    check("edit: the right password opens the editor", opened > 2, opened);
    await s.close();
  }

  // --- no WebGL: the ten tools become plain links ----------------------
  {
    const b2 = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2", "--disable-3d-apis",
        "--hide-scrollbars", "--no-first-run"],
    });
    try {
      const p = await b2.newPage();
      const w = watchPage(p);
      await p.setViewport({ width: 1440, height: 900 });
      await p.goto(SHELF_URL("light"), { waitUntil: "load" });
      await sleep(2000); // the probe + import attempt resolve without a scene
      const fb = await p.evaluate(() => ({
        open: document.getElementById("toolindex").classList.contains("toolindex--open"),
        frame: document.getElementById("shelf-root").hidden,
        note: !document.getElementById("toolindex-note").hidden,
        links: document.querySelectorAll("#toolindex a.toolindex__item").length,
      }));
      check("no-WebGL fallback: the tool list un-hides as plain links",
        fb.open && fb.frame && fb.note && fb.links === 10, JSON.stringify(fb));
      await p.click('#toolindex a[data-tool="merge"]');
      await p.waitForFunction(() => !document.getElementById("view-tool").hidden, { timeout: 5000 });
      const t = await p.evaluate(() => ({ hash: location.hash, panel: !document.getElementById("panel-merge").hidden }));
      check("no-WebGL fallback: a link opens its tool", t.hash === "#/merge" && t.panel, JSON.stringify(t));
      check("no-WebGL fallback: no external requests", w.ext.length === 0, w.ext.join(" | "));
      await p.close();
    } finally { await b2.close(); }
  }

  // --- reduced motion: calm scene, interactions still work -------------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    await sleep(600);
    await p.focus("#shelf-root canvas#gl");
    await p.keyboard.press("ArrowRight"); await sleep(150);
    await p.keyboard.press("Enter"); await sleep(400);
    const on = await p.evaluate(() => document.getElementById("detail").classList.contains("on"));
    await p.keyboard.press("Escape"); await sleep(300);
    const off = await p.evaluate(() => !document.getElementById("detail").classList.contains("on"));
    check("shelf reduced-motion: boots and stays interactive", on && off, `on=${on} off=${off}`);
    check("shelf reduced-motion: console stays clean", w.noise.length === 0, w.noise.join(" | "));
    await p.close();
  }

  // --- phone: flick bar, catalogue menu, touch, page scroll ------------
  {
    const p = await browser.newPage();
    const w = watchPage(p);
    // 480 tall keeps everything the flick-bar checks need on one screen.
    await p.setViewport({ width: 390, height: 480, isMobile: true, hasTouch: true });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await shelfBooted(p);
    await sleep(2200);
    const m = await p.evaluate(() => ({
      mbar: document.getElementById("mbar").classList.contains("on"),
      menuBtn: getComputedStyle(document.getElementById("menubtn")).display,
      footer: getComputedStyle(document.querySelector("#shelf-root footer")).display,
      mobile: document.getElementById("shelf-root").classList.contains("mobile"),
    }));
    check("shelf phone: flick bar replaces the catalogue rail",
      m.mbar && m.menuBtn !== "none" && m.footer === "none" && m.mobile, JSON.stringify(m));
    await p.click("#menubtn");
    await sleep(300);
    const menuN = await p.evaluate(() => ({
      hidden: document.getElementById("menu").hidden,
      n: document.querySelectorAll("#menu button").length,
    }));
    check("shelf phone: catalogue menu opens with 10 volumes", !menuN.hidden && menuN.n === 10, JSON.stringify(menuN));
    await p.click("#menu button");
    await sleep(300);
    const menuClosed = await p.evaluate(() => document.getElementById("menu").hidden);
    check("shelf phone: menu item selects and closes", menuClosed === true, String(menuClosed));
    const sp = await p.evaluate(() => {
      const r = document.getElementById("shelf-stage").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.5 };
    });
    await p.touchscreen.touchStart(sp.x, sp.y);
    await p.touchscreen.touchMove(sp.x, sp.y - 140);
    await p.touchscreen.touchEnd();
    await sleep(500);
    check("shelf phone: touch flick runs without errors", w.noise.length === 0, w.noise.join(" | "));
    check("shelf phone: no external requests", w.ext.length === 0, w.ext.join(" | "));
    await p.close();
  }

  // --- phone scroll: the shelf must not trap page scrolling ------------
  // A plain viewport on purpose: the isMobile emulation reports a much
  // taller layout viewport than requested (480 -> ~1184), where the whole
  // panel fits and there is nothing to scroll. At 390x520 the content
  // (655px) overflows, so the page has real scroll to do. The scene's
  // phone layout is width-driven, so the panel here is identical.
  {
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 520, hasTouch: true });
    await p.goto(SHELF_URL("light"), { waitUntil: "load" });
    await sleep(800);
    const scroll = await p.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, max + 999);
      return { y: window.scrollY, max };
    });
    check("shelf phone: the page still scrolls", scroll.max > 30 && scroll.y >= scroll.max - 2, JSON.stringify(scroll));
    await p.close();
  }

  // --- gallery: home, light + dark, 1440 / 768 / 390 -------------------
  for (const theme of ["light", "dark"]) {
    await shotShelf(`p6-shelf-${theme}-1440.png`, theme, 1440, 900);
    await shotShelf(`p6-shelf-${theme}-768.png`, theme, 768, 1000);
    await shotShelf(`p6-shelf-${theme}-390.png`, theme, 390, 1100);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
