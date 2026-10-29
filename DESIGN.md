# DESIGN.md: PDF Toolkit

Read this together with `PDFTOOL_SPEC.md`. The spec says what the app does. This file says how it looks and feels. Where the two conflict on visuals, this file wins.

## Intent
A quiet, precise document workbench. It should feel like a well-made desk tool: calm, sharp and confident, closer to a good stationery shop than a startup landing page. The people using it are students with a file and a deadline, so every screen should get them from "I have a file" to "I have the result" with the fewest steps.

The one memorable element is the **page strip**: after a file is added, its pages appear as real paper sheets. Every operation shows up on those sheets (a deleted page fades out, a rotated page turns, merged files line up in order). Everything else stays plain and disciplined so this one element stands out.

## Things to avoid
These are the common signs of an auto-generated page. Do not use them.
- Cream background with a serif headline and an orange or terracotta accent
- Near-black background with a neon green or red-orange accent
- Purple/blue gradients, gradient text, glow effects, glassmorphism blur
- A grid of identical rounded cards, one border radius on everything, the same soft grey shadow under everything
- Small all-caps tracked-out labels above headings
- Numbered markers (01, 02, 03) on things that are not a real sequence
- Emojis as icons or decoration
- Fade-and-slide-up on every section, hover lift on every card
- Arrows (→) added to button text, and "Welcome to..." hero copy
- Stock phrases like "Seamless", "Powerful", "Effortless", "Supercharge"
- Centered hero with a big headline, subtext and two buttons. This is a tool, so open straight into the workbench.

## Color
Define everything as CSS variables on `:root`, and override them under `[data-theme="dark"]`.

### Light
| Token | Value | Use |
|---|---|---|
| `--bg` | `#ECEEF2` | App background |
| `--surface` | `#FAFAFB` | Panels, inputs |
| `--surface-2` | `#E2E5EB` | Hover and pressed areas, rail background |
| `--line` | `#CDD2DB` | Borders and dividers |
| `--ink` | `#181B22` | Main text |
| `--ink-muted` | `#586071` | Secondary text |
| `--accent` | `#2A44C4` | Primary buttons, focus ring, active tool |
| `--accent-ink` | `#FFFFFF` | Text on accent |
| `--ok` | `#1B7A4E` | Success |
| `--danger` | `#B3261E` | Errors and destructive actions |
| `--paper` | `#FFFFFF` | Page thumbnails (always white, in both themes) |

### Dark
| Token | Value |
|---|---|
| `--bg` | `#101319` |
| `--surface` | `#181C24` |
| `--surface-2` | `#212631` |
| `--line` | `#2E3441` |
| `--ink` | `#E8EAEF` |
| `--ink-muted` | `#98A1B2` |
| `--accent` | `#8097FF` |
| `--accent-ink` | `#0B0F1E` |
| `--ok` | `#4FC38A` |
| `--danger` | `#FF8A80` |
| `--paper` | `#F4F5F7` |

Rules:
- One accent colour only. Success and error colours appear only for status.
- No gradients anywhere. Flat fills and borders.
- Text contrast at least 4.5:1 in both themes. Check `--ink-muted` on `--surface-2` especially.
- Dark mode is not an inversion. Pages stay white so they read as paper on a dark desk, which makes the thumbnails stand out more in dark mode.
- Theme: follow `prefers-color-scheme` on first visit, then remember the user's choice in `localStorage`. Add a small toggle in the header.

## Typography
Bundle the fonts locally as `.woff2` in `static/fonts/` (no CDN). Both are free on Google Fonts.

- **Headings and tool names:** Bricolage Grotesque, weights 600 and 700, slightly tight letter spacing (`-0.01em`)
- **Interface and body:** Instrument Sans, weights 400, 500 and 600
- Use `font-variant-numeric: tabular-nums` for file sizes, page counts and page numbers. Do not use a monospace face for decoration.

Type scale (rem, 16px base): 0.8125, 0.9375, 1, 1.125, 1.5, 2.25.
- Body 0.9375 to 1 rem, line-height 1.5
- Tool title (the heading of the active tool) 2.25 rem, weight 700, line-height 1.1
- Section and panel titles 1.125 rem, weight 600
- Helper text and captions 0.8125 rem, `--ink-muted`
- Sentence case everywhere. No all-caps labels, no tracked-out text.
- Keep text blocks under 70 characters wide.

## Layout
The app has two screens. **Home is the shelf**: a full-width framed room with ten volumes — one per tool — under a slim top bar. **Tool views** open from the shelf as hash routes and keep the workbench. Both are one column, never a grid of cards.

```
Home (the shelf)                     Tool view (#/merge)
+-------------------------------------------------------------+   +-------------------------------------------------------------+
| Folio                                          [sun/moon]   |   | Folio   Merge            [ (library) Shelf ] [sun/moon]     |
+-------------------------------------------------------------+   +-------------------------------------------------------------+
| +---------------------------------------------------------+ |   | Merge PDFs                                                  |
| |        the Ashen Press room: ten painted volumes        | |   | Combine files in the order shown below.                     |
| |        catalogue strip along the bottom edge            | |   |                                                             |
| +---------------------------------------------------------+ |   | +---------------------------------------------------------+ |
+-------------------------------------------------------------+   | |  Drop PDFs here, or choose files                        | |
                                                                  | +---------------------------------------------------------+ |
                                                                  |  Pages                                                       |
                                                                  |  [ pg ][ pg ][ pg ][ pg ][ pg ] ...                          |
                                                                  |  [ Merge PDFs ]            12 pages, 340 KB                 |
                                                                  +-------------------------------------------------------------+
```

- **Top bar (56px):** the Folio wordmark on the left — plain text on home, a link back to the shelf in tool views — the tool name as a quiet crumb, and on the right a "Shelf" button (with the library icon) plus the theme toggle.
- **Shelf home:** the scene fills what is left under the top bar, inside a 1px `--line` frame with the 10px panel radius. A hidden, screen-reader tool list carries the same ten links.
- **Workbench (fluid, max 960px, left aligned):** title, one line of help, the drop zone, the page strip, the options, then the action row. Everything is left aligned. Do not centre content. There is no left rail any more — the shelf is the navigation.
- **Action row:** one primary button on the left, a plain status line on the right (page count and size, updating live).
- **Protect is one view, two tabs:** a small tab row (Lock / Unlock) under the title switches two sub-panels; the tab is a real `tablist` with arrow-key movement. The same pattern covers Pages (Extract / Delete) and Text (Read / Edit): one book, one view, its jobs as tabs.
- Spacing uses a 4px base: 4, 8, 12, 16, 24, 32, 48. Use the larger steps between groups, the smaller ones inside them.

Tablet (700 to 1099px): the workbench padding tightens; the shelf room shrinks but keeps its proportions.
Mobile (under 700px): the scene switches to its authored phone mode (flick bar instead of the catalogue strip). The page strip scrolls sideways. Buttons are full width, and touch targets are at least 44px.

## Shape and depth
Different elements get different radii, so hierarchy is visible.
- Page thumbnails: 2px radius (they are paper)
- Buttons and inputs: 6px
- Panels and the drop zone: 10px
- No other radii

Depth:
- Panels and inputs use a 1px `--line` border and no shadow.
- Only page thumbnails have a shadow, a soft one that makes them look like sheets lying on a desk: `0 1px 2px rgba(20,24,34,.14), 0 6px 14px rgba(20,24,34,.08)`.
- When several files are stacked (merge), show a stack effect with two offset borders behind the top sheet.

## The page strip (signature element)
- Each page is a white sheet at A4 proportions (1 : 1.414), roughly 110px wide, showing the real rendered first page or page content (render with `pdf.js`, bundled locally). Under each sheet is its page number, tabular figures, `--ink-muted`.
- Between files in a merge, a thin vertical `--line` separator and the file name under the group.
- Interactions follow the tool:
  - **Pages (Extract / Delete):** click a sheet to select it. Selected sheets get a 2px `--accent` outline (Extract) or a diagonal strike and 40% opacity (Delete). The page-range input and the selection stay in sync both ways.
  - **Rotate:** the sheet turns with a 200ms ease-out when the angle changes.
  - **Merge and Images to PDF:** drag to reorder. The dragged sheet lifts slightly, and a 2px accent insertion line shows where it will land. Also support keyboard reordering (focus a sheet, then Alt + Left or Right).
  - **Split:** show cut lines between sheets that can be clicked to add or remove a split point.
  - **Watermark:** the stamp previews live on the sheets before the run — a quiet, absolutely positioned overlay with the chosen text, font, angle and opacity, so the strip still shows what will be in the output file.
- Before the action finishes, the strip shows the result: the sheets that will be in the output file.

## Components
- **Drop zone:** a 1px dashed `--line` border, 10px radius, `--surface` fill. Text: "Drop a PDF here, or choose a file" with "choose a file" as the clickable link. On drag-over: solid `--accent` border and a light accent tint (8% opacity). After a file is added, the zone shrinks to a single file row (name, size, a remove button) and the page strip appears below.
- **File row:** file name (weight 500), size and page count in `--ink-muted`, a remove icon button. Long names truncate in the middle and keep the extension.
- **Primary button:** `--accent` fill, `--accent-ink` text, 6px radius, 40px high, weight 600. Hover: slightly darker fill. Pressed: 1px translateY. Disabled: 40% opacity, no pointer.
- **Secondary button:** transparent, 1px `--line` border, `--ink` text.
- **Inputs:** `--surface`, 1px `--line` border, 6px radius, 40px high. Focus: 2px `--accent` outline with 2px offset. Always show a persistent label above the field and a helper line below (for example, "Pages: 1-3,5,8-").
- **Toggle for theme:** one icon button (sun or moon) with an accessible label.
- **Icons:** one set only (Lucide), inlined as SVG, 1.5px stroke, 18px in the rail and buttons. Bundle locally.

## Motion
Use motion only when it answers something the user did.
- Page rotate: 200ms ease-out
- Page delete fade and strike: 150ms
- Page reorder: 180ms transition on position
- Result ready: the download button replaces the action button with a 150ms cross-fade
- On first load, there is no entrance animation. The workbench is just there.
- Respect `prefers-reduced-motion: reduce` by turning off all transitions except opacity changes under 100ms.

## The text edit view (Text > Edit)
The one tool where the strip is not the whole story: editing rewrites the page in place, so the page itself becomes the workspace.

- The page shows as a large sheet (the same paper shadow as a thumbnail) with an overlay of real `<button>`s, one per text line. The overlay is `aria-hidden`; each button's accessible name carries the line text. The page strip keeps its plain sheets and switches the page.
- Clicking a line opens the panel below the page: the line's text, its matched font, size, bold/italic, colour. A substituted face (the original was a subset or is missing) says so in one quiet line.
- States are outlined, never only coloured: a queued change dashes its line in `--accent`, a deleted line sits under a `--danger` tint, added text is a dashed `--ok` box. Added and draft boxes are drawn divs, not buttons - they never take clicks.
- Edits queue in a list under the panel; each row undoes, redoes or reverts on its own. Nothing is written until **Save PDF**, which removes the original line (a redaction filled with the sampled background) and draws the new text with the matched font, or the closest bundled face. Overflowing text shrinks to fit and says so.
- "Add text" arms a crosshair; a click on empty paper drops the draft box and the panel takes over. A second click never stacks drafts.
- On a phone the page scrolls and zooms; a hint line says a larger screen works best for precise edits.

## States and copy
Voice: plain, direct, active verbs, sentence case. Buttons name the exact action, and the same action keeps the same name through the whole flow. Errors say what happened and what to do, with no apology.

| Moment | Copy |
|---|---|
| Shelf loading | Laying out the shelf… |
| Shelf panel button | Open Merge (the volume's own tool name) |
| No WebGL fallback | This browser can't show the shelf, so here are the ten tools as plain links. They all work the same. |
| Merge button | Merge PDFs |
| Working | Merging 3 files... |
| Done | Merged. Download merged.pdf |
| Split button | Split PDF |
| Extract button | Extract pages |
| Delete button | Delete pages |
| Watermark button | Add watermark |
| Text Read button | Extract text |
| Text Edit buttons | Apply change / Delete text / Add text |
| Rotate button | Rotate pages |
| Compress button | Compress PDF |
| Lock button | Add password |
| Unlock button | Remove password |
| Convert button | Convert to PDF |
| Empty strip | Add a PDF to see its pages here. |
| Bad range | "5-12" is outside this file. It has 8 pages. |
| Wrong file type | Only PDF files work here. This one is a .zip. |
| Password-protected | This PDF is locked. Enter its password to continue. |
| Scanned PDF (text tool) | No text found. This PDF looks like a scan, so there is nothing to copy yet. |
| Scanned PDF (edit tab) | No editable text found. This PDF looks like a scan. |
| Watermark image type | Watermark images work as PNG or JPG. This one is a .gif. |
| Edit, empty text | Type the new text before saving. |
| Converter missing | Word or LibreOffice is needed to convert this file. Install LibreOffice and try again. |
| Compress, little gain | Saved 2%. This file is mostly images, so it can't shrink much. |
| Server not running | Can't reach the local server. Start it with `python server.py` and refresh. |

Loading: a determinate progress bar (2px, `--accent`, under the action row) when progress is known, otherwise a slow indeterminate sweep. The button stays in place, shows the working label, and is disabled. No spinners over the whole page.

Success: the action button becomes "Download <filename>" and a quiet secondary button "Start over" appears. A line of `--ok` text with the result summary (for example, "12 pages, 340 KB") appears next to it.

## Accessibility and quality floor
- Visible focus ring on every interactive element (2px `--accent`, 2px offset), never removed
- Everything works by keyboard: the shelf scene (arrows, Enter, Escape), the drop zone (Enter opens the file picker), page selection (Space), reordering (Alt + arrows), the Protect tabs (arrow keys, roving tabindex)
- Use real `<button>`, `<label>` and `<nav>` elements, `aria-current="page"` on the matching entry of the hidden tool list, `aria-live="polite"` on status and error messages
- Colour is never the only signal: selected and deleted pages also change outline or strike
- Responsive down to 360px wide with no horizontal scroll except the page strip
- Print stylesheet not needed

## Implementation notes
- Plain HTML, CSS and JavaScript. One `style.css` with tokens at the top, in this order: reset, tokens, base type, layout, components, states, dark overrides.
- Avoid CSS specificity fights: use single-class selectors (BEM-like names such as `.toolindex__item`, `.strip__page`) and no element-plus-class overrides.
- All fonts, icons and `pdf.js` are bundled in `static/`. No external requests.
- Keep the wordmark simple: the app name "Folio" in Bricolage Grotesque 700, no logo mark. (Rename freely.)

## Shelf home
The **shelf** — the Ashen Press scene — is Folio's home screen and its only navigation. It is the one place a 3D scene is allowed, and it is an exception on purpose:

- **Ten volumes, one per tool.** Row 1: Merge, Split, Pages, Rotate, Compress. Row 2: Text, Watermark, Protect, To PDF, Info. Each cover is Folio's own painted artwork drawn at boot on a canvas: cloth in the group's colour (five muted tones — Organize slate blue, Edit olive, Protect oxblood, Convert pine, Inspect warm grey), a hairline foil frame, one geometric line-art emblem, the tool name embossed front and spine, and the group name where the publisher stamp used to be. No years, no volume numbers.
- **It is a framed room, not a page:** the scene keeps its own authored palette, type and motion inside a 1px `--line` frame with the 10px panel radius. Folio's tokens colour only the chrome around it — the top bar, the hidden tool list, focus rings, the no-WebGL fallback.
- **Clicking a book is navigation.** Click takes the volume down (the authored take-down); the panel that slides over the torn paper edge carries the group, the tool name, one line from the tool table and an **Open <Tool>** button that routes to `#/<tool>`. The browser's Back returns to the shelf. The "Look inside" flip stays reachable by drag, Space or Enter.
- **Loaded once, paused when busy.** Three.js loads at startup, just after the shell paints, behind the loader ("Laying out the shelf…", first mount only). Opening a tool — or hiding the tab — cancels the animation frame; the scene stays in memory and is never disposed while cycling views, so returning is instant. The device pixel ratio is capped at 2.
- **Graceful without WebGL.** The frame steps aside and the ten tools appear as a plain list of links in Folio's chrome, same routes, same behaviour. With `prefers-reduced-motion` the scene keeps running with instant states.
- Every other screen still follows every other rule in this file, including the page strip as the one memorable element of the workbench, flat surfaces, no shadows except paper, and the quality floor above.

## Build and review process
1. Build the shell first: top bar, the two views (home shelf, tool workbench), light and dark tokens. Check both themes at 1440, 768 and 390 pixels wide before adding tools.
2. Build the drop zone, file row and page strip with Merge, since it exercises everything.
3. Add the remaining tools by reusing the same components. Do not invent new component styles per tool.
4. Final review pass: screenshot each tool in both themes and ask:
   - Does anything look like it came from a template? Remove or rework it.
   - Is there more than one attention-grabbing element on a screen? Keep only the page strip.
   - Are any labels, borders or decorations present without a reason? Remove one.
5. Test with long file names, a 200-page PDF, a failed upload, and with the server turned off.
