import { api, esc, fmtDate, fmtSize } from "./common.js";

// Public page for a quick-send link: lists exactly the files that were sent, with downloads. No sign-in, no project access.
const app = document.getElementById("app");
const token = location.pathname.split("/")[2];
const T = `/api/s/${encodeURIComponent(token)}`;

function page(inner) {
  app.innerHTML = `<div class="page narrow">
    <img src="/crafter-engineering-logo-white.png" alt="Crafter Engineering" class="brand-logo" />
    ${inner}
  </div>`;
}

async function start() {
  let data;
  try {
    data = await api(T);
  } catch (err) {
    page(`<h1>Link unavailable</h1><p class="muted">${esc(err.status === 404 ? "This link has expired, was cancelled, or doesn't exist. Ask the sender for a new one." : err.message)}</p>`);
    return;
  }
  const total = data.files.reduce((sum, f) => sum + f.size, 0);
  page(`
    <h1>Files shared with you</h1>
    <p class="muted">From ${esc(data.sender)}. Available until ${esc(fmtDate(data.expiresAt))}.</p>
    ${data.message ? `<section class="card"><p class="share-message">${esc(data.message)}</p></section>` : ""}
    <section class="card">
      ${data.files
        .map(
          (f) => `<div class="file-row">
            <div class="file-main"><span class="file-name">${esc(f.name)}</span><span class="file-meta">${fmtSize(f.size)}</span></div>
            <div class="file-actions"><a class="button secondary small" href="${T}/files/${f.n}">Download</a></div>
          </div>`
        )
        .join("")}
      ${data.files.length > 1 ? `<div class="modal-actions"><a class="button" href="${T}/zip">Download all (.zip, ${fmtSize(total)})</a></div>` : ""}
    </section>
    <p class="muted small">This link only gives access to the files listed above.</p>
    <p class="legal-note">These files are confidential and may be protected by copyright belonging to Crafter Engineering or to other companies. Please don't copy, share or reuse them beyond the purpose they were sent for without permission.</p>`);
}

start();
