import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "./common.js";

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

function showMessage(html) {
  statusEl.innerHTML = html;
  statusEl.classList.remove("hidden");
}

async function start() {
  let info;
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
  document.getElementById("file-name").textContent = info.name;
  document.getElementById("back-link").href = `/p/${info.project.id}`;

  if (info.canDownload) {
    const button = document.getElementById("download-button");
    button.classList.remove("hidden");
    button.addEventListener("click", () => (location.href = `/api/files/${fileId}/download`));
  } else {
    // View-only access: no download button, no print, no right-click save.
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
    if (box.dataset.renderedScale === String(scale)) box.replaceChildren(canvas);
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

start();
