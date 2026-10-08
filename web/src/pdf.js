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
let observer = null;
let info = null;
let currentPage = 1;

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
  setupRevisionBanner(info, new URLSearchParams(location.search).get("scanned"));
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
  buildPages(firstViewport);
  setupQrPlacement();
}

function buildPages(firstViewport) {
  observer?.disconnect();
  pagesEl.innerHTML = "";
  pageBoxes = [];
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page));
    },
    { root: scroller, rootMargin: "600px 0px" }
  );
  for (let n = 1; n <= pdf.numPages; n++) {
    const box = document.createElement("div");
    box.className = "pdf-page";
    box.dataset.page = String(n);
    box.style.width = `${firstViewport.width * scale}px`;
    box.style.height = `${firstViewport.height * scale}px`;
    pagesEl.append(box);
    pageBoxes.push(box);
    observer.observe(box);
  }
  updatePageInfo();
}

async function renderPage(n) {
  const box = pageBoxes[n - 1];
  if (!box || box.dataset.renderedScale === String(scale)) return;
  box.dataset.renderedScale = String(scale);
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  box.style.width = `${viewport.width}px`;
  box.style.height = `${viewport.height}px`;
  const params = { canvas, viewport };
  if (ratio !== 1) params.transform = [ratio, 0, 0, ratio, 0, 0];
  try {
    await page.render(params).promise;
    if (box.dataset.renderedScale === String(scale)) {
      box.replaceChildren(canvas);
      if (placing?.page === n) attachOverlay();
    }
  } catch (err) {
    console.error("PDF page render failed", err);
    delete box.dataset.renderedScale;
    box.textContent = `Could not draw page ${n}: ${err.message}`;
  }
}

function setScale(next) {
  scale = Math.min(4, Math.max(0.25, next));
  for (const box of pageBoxes) {
    box.replaceChildren();
    delete box.dataset.renderedScale;
  }
  // Resize placeholders using page 1's proportions; real size is applied when each page renders.
  pdf.getPage(1).then((p) => {
    const vp = p.getViewport({ scale });
    for (const box of pageBoxes) {
      box.style.width = `${vp.width}px`;
      box.style.height = `${vp.height}px`;
    }
    observer.disconnect();
    for (const box of pageBoxes) observer.observe(box);
  });
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
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    updatePageInfo();
    ticking = false;
  });
});

document.getElementById("zoom-in").addEventListener("click", () => pdf && (setScale(scale * 1.25), updatePageInfo()));
document.getElementById("zoom-out").addEventListener("click", () => pdf && (setScale(scale / 1.25), updatePageInfo()));
document.getElementById("zoom-fit").addEventListener("click", () => pdf && (setScale(fitScale), updatePageInfo()));

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
