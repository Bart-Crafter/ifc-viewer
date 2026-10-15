import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import QRCode from "qrcode";
import { api, setupRevisionBanner, toast } from "./common.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const fileId = location.pathname.split("/")[3];
const scroller = document.getElementById("pdf-scroll");
const pagesEl = document.getElementById("pdf-pages");
const statusEl = document.getElementById("pdf-status");
const pageInfo = document.getElementById("page-info");

let pdf = null;
let scale = 1;
let fitScale = 1;
let pageBoxes = [];
let info = null;
let currentPage = 1;
let firstBase = { w: 1, h: 1 }; // page 1 at 100%, used to size pages that haven't been drawn yet

function showMessage(html) {
  statusEl.innerHTML = html;
  statusEl.classList.remove("hidden");
}

async function start() {
  try {
    info = await api(`/api/files/${encodeURIComponent(fileId)}`);
  } catch (err) {
    if (err.message === "password_change_required") return void (location.href = "/");
    document.getElementById("file-name").textContent = "Can't open this file";
    showMessage(
      err.status === 401 || err.status === 403
        ? `${err.status === 401 ? "Please sign in" : "You don't have access to this file"}. <a href="/">Go to the sign-in page</a>.`
        : err.message
    );
    return;
  }

  document.title = `${info.name} — Crafter Engineering`;
  setupRevisionBanner(info);
  document.getElementById("file-name").textContent = info.name;
  document.getElementById("back-link").href = `/p/${info.project.id}`;

  if (!info.canDownload) {
    // View-only access: no print, no right-click save.
    document.body.classList.add("no-print");
    pagesEl.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && ["s", "p"].includes(e.key.toLowerCase())) e.preventDefault();
    });
  }

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/content`, { credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "Could not load the PDF.");
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
  } catch (err) {
    showMessage(err.message);
    return;
  }

  statusEl.classList.add("hidden");
  const first = await pdf.getPage(1);
  const firstViewport = first.getViewport({ scale: 1 });
  fitScale = Math.min(2, Math.max(0.3, (scroller.clientWidth - 32) / firstViewport.width));
  scale = fitScale;
  firstBase = { w: firstViewport.width, h: firstViewport.height };
  buildPages(firstViewport);
  setupQrPlacement();
}

function buildPages(firstViewport) {
  pagesEl.innerHTML = "";
  pageBoxes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const box = document.createElement("div");
    box.className = "pdf-page";
    box.dataset.page = String(n);
    box.style.width = `${firstViewport.width * scale}px`;
    box.style.height = `${firstViewport.height * scale}px`;
    pagesEl.append(box);
    pageBoxes.push(box);
  }
  updatePageInfo();
  renderVisible();
}

// ---------- drawing only what is on screen ----------
// A big drawing at a high zoom would need a canvas of tens of millions of pixels per page, which browsers drop or
// blank when memory is short (the drawing "disappears" as you scroll). So each page is drawn into a canvas covering
// just the part that is visible (plus some spare around it), redrawn as you scroll or zoom, and freed when the page
// is far away. The memory used no longer depends on the size of the sheet or the zoom.
//
// Nothing is ever removed before its replacement is ready, so there is no flash: a small whole-page picture sits
// behind the sharp window (anything not drawn yet shows soft instead of blank), and on zoom the old window is
// simply stretched to the new size until the sharp one swaps in.
const MAX_WINDOW_PIXELS = 12_000_000;
const MAX_THUMB_PIXELS = 3_000_000;
const SPARE = 0.6; // spare drawn beyond the visible area, as a fraction of the screen size, each side

function dropCanvas(box) {
  box._canvas?.remove();
  box._canvas = null;
  box._win = null;
  box._thumb?.remove();
  box._thumb = null;
}

// Stretch a page's existing sharp window to the current zoom (it is replaced by a fresh one a moment later).
function fitWindow(box) {
  const canvas = box._canvas;
  const win = box._win;
  if (!canvas || !win) return;
  const k = scale / win.scale;
  canvas.style.left = `${win.x * k}px`;
  canvas.style.top = `${win.y * k}px`;
  canvas.style.width = `${win.w * k}px`;
  canvas.style.height = `${win.h * k}px`;
}

function overlap(box) {
  const b = box.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  // visible part of the page in the page's own CSS pixels, grown by `grow` of the screen size each side
  const grown = (grow) => {
    const gx = s.width * grow;
    const gy = s.height * grow;
    const x0 = Math.max(0, s.left - gx - b.left);
    const y0 = Math.max(0, s.top - gy - b.top);
    const x1 = Math.min(b.width, s.right + gx - b.left);
    const y1 = Math.min(b.height, s.bottom + gy - b.top);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  return { visible: grown(0), window: grown(SPARE), near: grown(1.5) };
}

// A modest picture of the whole page, drawn once, that shows through wherever the sharp window hasn't reached yet.
async function ensureThumb(box, page) {
  if (box._thumb || box._thumbBusy) return;
  box._thumbBusy = true;
  try {
    const base = page.getViewport({ scale: 1 });
    const k = Math.min(2, Math.sqrt(MAX_THUMB_PIXELS / (base.width * base.height)));
    const viewport = page.getViewport({ scale: k });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.className = "pdf-thumb";
    await page.render({ canvas, viewport }).promise;
    if (!box.isConnected || box._thumb) return;
    box.prepend(canvas);
    box._thumb = canvas;
  } catch (err) {
    console.warn("PDF thumbnail failed", err);
  } finally {
    box._thumbBusy = false;
  }
}

async function renderPage(n) {
  const box = pageBoxes[n - 1];
  if (!box) return;
  if (box._busy) {
    box._dirty = true;
    return;
  }
  box._busy = true;
  try {
    do {
      box._dirty = false;
      const startScale = scale;
      const o = overlap(box);
      if (!o.near) {
        dropCanvas(box); // far from the screen: free the memory
        continue;
      }
      if (!o.visible) continue; // near, but nothing of it on screen yet: leave as is
      const have = box._win;
      const covered = have && have.scale === startScale && o.visible.x >= have.x && o.visible.y >= have.y && o.visible.x + o.visible.w <= have.x + have.w && o.visible.y + o.visible.h <= have.y + have.h;
      if (covered) continue;

      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      box._base = { w: base.width, h: base.height };
      if (!box._thumb) await ensureThumb(box, page);
      const viewport = page.getViewport({ scale: startScale });
      box.style.width = `${viewport.width}px`;
      box.style.height = `${viewport.height}px`;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // the area to draw: the visible part with spare around it, trimmed so the canvas stays a sane size
      let w = o.window.w;
      let h = o.window.h;
      const pixels = w * h * ratio * ratio;
      if (pixels > MAX_WINDOW_PIXELS) {
        const k = Math.sqrt(MAX_WINDOW_PIXELS / pixels);
        const cx = o.visible.x + o.visible.w / 2;
        const cy = o.visible.y + o.visible.h / 2;
        w = Math.max(o.visible.w, w * k);
        h = Math.max(o.visible.h, h * k);
        o.window = { x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h };
      }
      const win = { x: Math.floor(o.window.x), y: Math.floor(o.window.y), w: Math.ceil(Math.min(o.window.w, viewport.width - Math.floor(o.window.x))), h: Math.ceil(Math.min(o.window.h, viewport.height - Math.floor(o.window.y))), scale: startScale };
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(win.w * ratio));
      canvas.height = Math.max(1, Math.floor(win.h * ratio));
      canvas.className = "pdf-window";
      canvas.style.cssText = `position:absolute;left:${win.x}px;top:${win.y}px;width:${win.w}px;height:${win.h}px`;
      try {
        await page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, -win.x * ratio, -win.y * ratio] }).promise;
      } catch (err) {
        console.error("PDF page render failed", err);
        box.dataset.error = err.message;
        continue;
      }
      if (startScale !== scale) {
        box._dirty = true; // zoomed again meanwhile: this picture is for the old size
        continue;
      }
      // swap in the same frame: the new window goes in, the old one comes out
      box.append(canvas);
      box._canvas?.remove();
      box._canvas = canvas;
      box._win = win;
      if (typeof placing !== "undefined" && placing?.page === n) attachOverlay();
    } while (box._dirty);
  } finally {
    box._busy = false;
  }
}

let renderTimer = null;
function renderVisible() {
  clearTimeout(renderTimer);
  renderTimer = null;
  for (let n = 1; n <= pageBoxes.length; n++) renderPage(n);
}
const renderVisibleSoon = () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderVisible, 70);
};

function setScale(next, anchor = null) {
  const before = scale;
  const target = Math.min(4, Math.max(0.25, next));
  if (target === before) return;
  // keep the point under the pointer (or, for the buttons, the middle of the screen) where it is
  if (!anchor) {
    const cx = scroller.clientWidth / 2;
    const cy = scroller.clientHeight / 2;
    anchor = { cx, cy, fx: scroller.scrollLeft + cx, fy: scroller.scrollTop + cy };
  }
  scale = target;
  // Everything below happens in one go, so the browser never paints a half-changed state.
  for (const box of pageBoxes) {
    const base = box._base || firstBase;
    box.style.width = `${base.w * scale}px`;
    box.style.height = `${base.h * scale}px`;
    fitWindow(box);
  }
  scroller.scrollLeft = (anchor.fx / before) * scale - anchor.cx;
  scroller.scrollTop = (anchor.fy / before) * scale - anchor.cy;
  updatePageInfo();
  renderVisible();
}

function updatePageInfo() {
  if (!pdf) return;
  const middle = scroller.scrollTop + scroller.clientHeight / 2;
  let current = 1;
  for (const box of pageBoxes) {
    if (box.offsetTop <= middle) current = Number(box.dataset.page);
    else break;
  }
  currentPage = current;
  pageInfo.textContent = `Page ${current} of ${pdf.numPages} · ${Math.round(scale * 100)}%`;
}

let ticking = false;
scroller.addEventListener("scroll", () => {
  renderVisibleSoon(); // draw what has come into view
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    updatePageInfo();
    ticking = false;
  });
});
window.addEventListener("resize", renderVisibleSoon);

document.getElementById("zoom-in").addEventListener("click", () => pdf && setScale(scale * 1.25));
document.getElementById("zoom-out").addEventListener("click", () => pdf && setScale(scale / 1.25));
document.getElementById("zoom-fit").addEventListener("click", () => {
  if (!pdf) return;
  setScale(fitScale);
  scroller.scrollLeft = 0;
});

// ----- mouse: wheel zooms (around the pointer); left, middle or right button drags the drawing around -----
let pendingScale = null;
let zoomAnchor = null;
let zoomTimer = null;
scroller.addEventListener(
  "wheel",
  (event) => {
    if (!pdf) return;
    event.preventDefault();
    const rect = scroller.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    if (!zoomAnchor) zoomAnchor = { cx, cy, fx: scroller.scrollLeft + cx, fy: scroller.scrollTop + cy }; // content point under the pointer, at the current scale
    const step = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0016));
    pendingScale = Math.min(4, Math.max(0.25, (pendingScale ?? scale) * step));
    // instant (soft-focus) feedback while the wheel is turning; the pages are redrawn sharp when it pauses
    pagesEl.style.transformOrigin = `${zoomAnchor.fx}px ${zoomAnchor.fy}px`;
    pagesEl.style.transform = `scale(${pendingScale / scale})`;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      const target = pendingScale;
      const anchor = zoomAnchor;
      pendingScale = null;
      zoomAnchor = null;
      pagesEl.style.transform = "";
      pagesEl.style.transformOrigin = "";
      setScale(target, anchor); // same tick as removing the preview: no frame in between
    }, 110);
  },
  { passive: false }
);

let pan = null;
scroller.addEventListener("mousedown", (event) => {
  if (event.button === 1) event.preventDefault(); // no browser auto-scroll circle
});
scroller.addEventListener("contextmenu", (event) => event.preventDefault()); // the right button pans
scroller.addEventListener("pointerdown", (event) => {
  const side = event.button === 1 || event.button === 2;
  const left = event.button === 0 && event.pointerType === "mouse"; // a finger scrolls natively
  if (!side && !left) return;
  if (event.target.closest(".qr-overlay")) return; // that drags the QR code, not the page
  event.preventDefault();
  pan = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
  scroller.setPointerCapture(event.pointerId);
  scroller.classList.add("panning");
});
scroller.addEventListener("pointermove", (event) => {
  if (!pan) return;
  scroller.scrollLeft = pan.left - (event.clientX - pan.x);
  scroller.scrollTop = pan.top - (event.clientY - pan.y);
});
for (const type of ["pointerup", "pointercancel"]) {
  scroller.addEventListener(type, () => {
    pan = null;
    scroller.classList.remove("panning");
  });
}

// ---------- placing the QR code on the drawing ----------
// The designer drags the QR code to where it should go on the sheet (and resizes it), so nothing about the title block
// has to change. The position is kept as fractions of the page, so it holds at any zoom, and is sent to the server,
// which draws the code into the PDF itself.
const MM_PER_PT = 25.4 / 72;
const MIN_FRACTION = 0.02;
const MAX_FRACTION = 0.6;
let placing = null; // { page, x, y, w, svg, all, sizes: { [page]: { w, h } } } while placing
let overlayEl = null;

const qrBar = document.getElementById("qr-bar");
const addQrButton = document.getElementById("add-qr-button");

function setupQrPlacement() {
  if (!info?.canStampQr) return;
  addQrButton.classList.remove("hidden");
  if (info.qr) {
    addQrButton.textContent = "QR ✓";
    addQrButton.disabled = true;
    addQrButton.title = "This PDF already has its QR code. Replace it with a fresh export to place a new one.";
    return;
  }
  addQrButton.addEventListener("click", startPlacement);
  if (new URLSearchParams(location.search).get("qr") === "1") startPlacement();
}

async function pageSize(n) {
  if (placing.sizes[n]) return placing.sizes[n];
  const viewport = (await pdf.getPage(n)).getViewport({ scale: 1 }); // points, as displayed (rotation included)
  return (placing.sizes[n] = { w: viewport.width, h: viewport.height });
}

async function startPlacement() {
  if (placing) return;
  let link;
  try {
    link = await api(`/api/files/${encodeURIComponent(fileId)}/link`);
  } catch (err) {
    return toast(err.message, "error");
  }
  const svg = await QRCode.toString(link.url, { type: "svg", errorCorrectionLevel: "L", margin: 2 });
  placing = { page: Math.min(currentPage, pdf.numPages), x: 0, y: 0, w: 0.1, svg, all: false, sizes: {} };
  const last = link.placement; // where it went on an earlier revision of this drawing
  const size = await pageSize(placing.page);
  if (last && Number.isFinite(last.w)) {
    Object.assign(placing, { page: Math.min(Math.max(1, last.page || 1), pdf.numPages), x: last.x, y: last.y, w: last.w });
  } else {
    // default: about 22 mm, in the bottom-right corner, 8 mm in from the edges
    const w = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, 22 / MM_PER_PT / size.w));
    const h = (w * size.w) / size.h;
    placing.w = w;
    placing.x = 1 - w - 8 / MM_PER_PT / size.w;
    placing.y = 1 - h - 8 / MM_PER_PT / size.h;
  }
  document.getElementById("qr-page").max = String(pdf.numPages);
  document.getElementById("qr-page").value = String(placing.page);
  document.querySelector(".qr-all").classList.toggle("hidden", pdf.numPages === 1);
  qrBar.classList.remove("hidden");
  document.body.classList.add("placing-qr");
  attachOverlay();
  pageBoxes[placing.page - 1]?.scrollIntoView({ block: "center" });
}

function stopPlacement() {
  overlayEl?.remove();
  overlayEl = null;
  placing = null;
  qrBar.classList.add("hidden");
  document.body.classList.remove("placing-qr");
  const params = new URLSearchParams(location.search);
  if (params.has("qr")) {
    params.delete("qr");
    history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}`);
  }
}

// Height as a fraction of the page height, for a square box of width `w`.
const heightFraction = (box) => (placing.w * box.getBoundingClientRect().width) / box.getBoundingClientRect().height;

async function updateSizeLabel() {
  const size = await pageSize(placing.page);
  document.getElementById("qr-size-label").textContent = `${Math.round(placing.w * size.w * MM_PER_PT)} mm`;
}

function layoutOverlay() {
  const box = pageBoxes[placing.page - 1];
  overlayEl.style.left = `${placing.x * 100}%`;
  overlayEl.style.top = `${placing.y * 100}%`;
  overlayEl.style.width = `${placing.w * 100}%`;
  if (box) overlayEl.style.height = `${heightFraction(box) * 100}%`;
  updateSizeLabel();
}

function keepOnPage(box) {
  placing.w = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, placing.w));
  placing.x = Math.min(Math.max(0, placing.x), Math.max(0, 1 - placing.w));
  placing.y = Math.min(Math.max(0, placing.y), Math.max(0, 1 - heightFraction(box)));
}

function attachOverlay() {
  overlayEl?.remove();
  const box = pageBoxes[placing.page - 1];
  if (!box) return;
  overlayEl = document.createElement("div");
  overlayEl.className = "qr-overlay";
  overlayEl.innerHTML = `${placing.svg}<div class="qr-handle" aria-label="Resize"></div>`;
  box.append(overlayEl);
  layoutOverlay();

  let drag = null;
  overlayEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const resizing = event.target.classList.contains("qr-handle");
    const rect = box.getBoundingClientRect();
    drag = { resizing, startX: event.clientX, startY: event.clientY, x: placing.x, y: placing.y, w: placing.w, rect };
    overlayEl.setPointerCapture(event.pointerId);
  });
  overlayEl.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.rect.width;
    const dy = (event.clientY - drag.startY) / drag.rect.height;
    if (drag.resizing) {
      placing.w = drag.w + dx; // the corner follows the pointer; the box stays square
    } else {
      placing.x = drag.x + dx;
      placing.y = drag.y + dy;
    }
    keepOnPage(box);
    layoutOverlay();
  });
  for (const type of ["pointerup", "pointercancel"]) overlayEl.addEventListener(type, () => (drag = null));
}

async function nudgeSize(deltaMm) {
  const size = await pageSize(placing.page);
  placing.w += (deltaMm / MM_PER_PT) / size.w;
  keepOnPage(pageBoxes[placing.page - 1]);
  layoutOverlay();
}

document.getElementById("qr-smaller").addEventListener("click", () => placing && nudgeSize(-2));
document.getElementById("qr-bigger").addEventListener("click", () => placing && nudgeSize(2));
document.getElementById("qr-all").addEventListener("change", (e) => placing && (placing.all = e.target.checked));
document.getElementById("qr-page").addEventListener("change", (e) => {
  if (!placing) return;
  placing.page = Math.min(pdf.numPages, Math.max(1, Math.round(Number(e.target.value) || 1)));
  e.target.value = String(placing.page);
  attachOverlay();
  keepOnPage(pageBoxes[placing.page - 1]);
  layoutOverlay();
  pageBoxes[placing.page - 1]?.scrollIntoView({ block: "center" });
});
document.getElementById("qr-cancel").addEventListener("click", stopPlacement);
document.getElementById("qr-apply").addEventListener("click", async (event) => {
  if (!placing) return;
  event.target.disabled = true;
  event.target.textContent = "Adding…";
  try {
    const result = await api(`/api/files/${encodeURIComponent(fileId)}/stamp-qr`, {
      method: "POST",
      json: { page: placing.page, x: placing.x, y: placing.y, w: placing.w, allPages: placing.all },
    });
    toast(result.note);
    setTimeout(() => (location.href = location.pathname), 900); // reload to show the stamped PDF
  } catch (err) {
    toast(err.message, "error");
    event.target.disabled = false;
    event.target.textContent = "Add QR here";
  }
});


start();
