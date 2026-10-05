const listEl = document.getElementById("model-list");
const form = document.getElementById("upload-form");
const statusEl = document.getElementById("upload-status");

const qrModal = document.getElementById("qr-modal");
const qrImage = document.getElementById("qr-image");
const qrUrl = document.getElementById("qr-url");
document.getElementById("close-qr").addEventListener("click", () => qrModal.classList.add("hidden"));

function showQr(id, name) {
  qrImage.src = `/api/models/${id}/qr.png?t=${Date.now()}`;
  const url = `${location.origin}/model/${id}`;
  qrUrl.textContent = `${name} — ${url}`;
  qrModal.classList.remove("hidden");
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString();
}

const TOKEN_KEY = "ifc-viewer-upload-token";

// Publishing/revising can be gated behind an upload token (see server UPLOAD_TOKEN env var).
// If the server has no token configured, every request here just succeeds as normal.
async function authedFetch(url, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    const entered = prompt("This server requires an upload token to publish or revise models:");
    if (!entered) return res;
    localStorage.setItem(TOKEN_KEY, entered);
    res = await fetch(url, { ...options, headers: { ...headers, Authorization: `Bearer ${entered}` } });
  }

  return res;
}

async function loadModels() {
  const res = await fetch("/api/models");
  const models = await res.json();

  if (models.length === 0) {
    listEl.innerHTML = '<p class="empty">No models published yet. Upload an IFC file above to get started.</p>';
    return;
  }

  listEl.innerHTML = "";
  for (const model of models) {
    const card = document.createElement("div");
    card.className = "model-card";
    card.innerHTML = `
      <div class="info">
        <strong>${model.passwordProtected ? "🔒 " : ""}${escapeHtml(model.name)}</strong>
        <span>ID ${model.id} · rev ${model.revision} · updated ${fmtDate(model.updatedAt)}</span>
      </div>
      <div class="actions">
        <a href="/model/${model.id}">View</a>
        <button class="secondary qr-btn" type="button">QR</button>
        <label class="revise-label">
          New revision
          <input type="file" accept=".ifc" class="revise-input" hidden />
        </label>
        <button class="secondary password-btn" type="button">${model.passwordProtected ? "Change password" : "Add password"}</button>
        <button class="secondary delete-btn" type="button">Delete</button>
      </div>
    `;

    card.querySelector(".qr-btn").addEventListener("click", () => showQr(model.id, model.name));

    const reviseInput = card.querySelector(".revise-input");
    reviseInput.addEventListener("change", async () => {
      const file = reviseInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      card.querySelector(".info span").textContent = "Converting new revision…";
      const res = await authedFetch(`/api/models/${model.id}/revise`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Revision failed: ${err.detail || err.error || res.statusText}`);
      }
      await loadModels();
    });

    card.querySelector(".password-btn").addEventListener("click", async () => {
      const entered = prompt(
        model.passwordProtected
          ? `Set a new password for "${model.name}", or leave blank to remove password protection:`
          : `Set a password to require it for viewing "${model.name}" (leave blank to cancel):`
      );
      if (entered === null) return;
      if (entered === "" && !model.passwordProtected) return;
      const res = await authedFetch(`/api/models/${model.id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: entered || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Couldn't update password: ${err.detail || err.error || res.statusText}`);
      }
      await loadModels();
    });

    card.querySelector(".delete-btn").addEventListener("click", async () => {
      if (!confirm(`Delete "${model.name}" (${model.id})? This can't be undone — its QR code will stop working.`)) return;
      const res = await authedFetch(`/api/models/${model.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({}));
        alert(`Couldn't delete: ${err.detail || err.error || res.statusText}`);
      }
      await loadModels();
    });

    listEl.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fd = new FormData(form);
  if (!fd.get("file") || fd.get("file").size === 0) return;

  statusEl.textContent = "Converting IFC — this can take a while for large models…";
  statusEl.className = "";

  try {
    const res = await authedFetch("/api/models", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || res.statusText);

    statusEl.textContent = `Published "${data.name}" as model ${data.id}.`;
    statusEl.className = "success";
    form.reset();
    await loadModels();
  } catch (err) {
    statusEl.textContent = `Conversion failed: ${err.message}`;
    statusEl.className = "error";
  }
});

loadModels();
