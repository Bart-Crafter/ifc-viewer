import { api, esc, loginCard } from "./common.js";

// Landing page for the QR code printed on a drawing. It finds the newest revision of that drawing this person can
// open and sends them to the viewer, which tells them if the revision they scanned has been superseded.
const app = document.getElementById("app");
const pid = location.pathname.split("/")[2];
const params = new URLSearchParams(location.search);
const series = params.get("s") || "";
const scanned = params.get("rev") || "";
const key = params.get("k");

function page(inner) {
  app.innerHTML = `<div class="page narrow">
    <img src="/crafter-engineering-logo.png" alt="Crafter Engineering" class="brand-logo" />
    ${inner}
  </div>`;
}

async function start() {
  page('<h1>Opening the latest revision…</h1><p class="muted">Checking you have the current drawing.</p>');
  if (key) {
    // Same as scanning the project QR: a correct key gives view-only access to the public folders.
    await api(`/api/projects/${encodeURIComponent(pid)}/link-session`, { method: "POST", json: { key } }).catch(() => {});
    params.delete("k");
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }
  try {
    const found = await api(`/api/projects/${encodeURIComponent(pid)}/resolve?series=${encodeURIComponent(series)}&rev=${encodeURIComponent(scanned)}`);
    if (found.type !== "pdf" && found.type !== "ifc") {
      page(`<h1>${esc(found.name)}</h1><p class="muted">This kind of file can't be viewed online.</p><p><a class="button" href="/p/${esc(pid)}">Open the project</a></p>`);
      return;
    }
    location.replace(`/view/${found.type}/${encodeURIComponent(found.id)}?scanned=${encodeURIComponent(scanned)}`);
  } catch (err) {
    if (err.status === 401) {
      page(`<h1>Sign in to see this drawing</h1><p class="muted">This drawing isn't open to everyone with the QR code. Sign in with your account.</p><div id="login"></div>`);
      app.querySelector("#login").append(loginCard({ title: "Sign in", onSuccess: () => location.reload() }));
    } else if (err.status === 403) {
      page(`<h1>No access</h1><p class="muted">${esc(err.message)}</p>`);
    } else {
      page(`<h1>Drawing not found</h1><p class="muted">${esc(err.message)} Ask the person who gave you the drawing for the current one.</p><p><a class="button" href="/p/${esc(pid)}">Open the project</a></p>`);
    }
  }
}

start();
