import {
  api,
  esc,
  fmtDate,
  fmtSize,
  loadMe,
  loginCard,
  openModal,
  passwordChangeModal,
  showSecret,
  toast,
  topbarHtml,
  uploadFile,
  wireTopbar,
  ROLE_HELP,
  ROLE_LABELS,
} from "./common.js";

const app = document.getElementById("app");
const pid = location.pathname.split("/")[2];
const RANK = { viewer: 1, client: 2, designer: 3, admin: 4 };
const can = (role, min) => !!role && RANK[role] >= RANK[min];
const P = `/api/projects/${encodeURIComponent(pid)}`;

const FOLDER_HINTS = {
  pdf: "Drawings and documents. View in the browser.",
  dwg: "CAD drawings.",
  ifc: "3D models. View in the browser.",
  calcs: "Calculations and reports.",
  other: "Anything else.",
};
// Folders that only take one kind of file; the others accept anything sensible.
const FOLDER_ACCEPT = { pdf: ".pdf", dwg: ".dwg", ifc: ".ifc" };

let user = null;
let info = null;
let role = null;
let via = null;
let folders = [];
let files = [];
const selected = new Set(); // file ids picked for a quick-send link
let hideOld = null; // hide superseded revisions (default: on for people who only view)
let pollTimer = null;

function shell(inner) {
  app.innerHTML = `${topbarHtml(user)}<div class="page">${inner}${legalFooter()}</div>`;
  wireTopbar(app, { afterSignOut: () => location.reload() });
}

// ---------- copyright / sharing rights ----------
const LEGAL_NOTICE =
  "Files on this site are confidential and may be protected by copyright belonging to Crafter Engineering or to other companies. Do not copy, share or reuse them without permission. If you think something here shouldn't be, tell your Crafter Engineering contact and we will review it promptly.";
const legalFooter = () => `<p class="legal-note">${esc(LEGAL_NOTICE)}</p>`;

// Asked once per browser session before any upload; the server also requires it (and records it).
function confirmRights() {
  try {
    if (sessionStorage.getItem("rights-confirmed") === "1") return Promise.resolve(true);
  } catch {}
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h3>Before you upload</h3>
      <p>Anything uploaded here can be seen by the people with access to the folder, and (in public folders) by anyone holding the project QR code.</p>
      <p>Check the file doesn't contain material that belongs to someone else that we haven't been given permission to share: other companies' drawings or title blocks (including external references), Ordnance Survey or other map data, manufacturers' CAD, photographs, or extracts of standards.</p>
      <label class="check-line"><input type="checkbox" id="rights-ok" /> <span>I confirm Crafter Engineering has the right to share this file with the people who can open this folder.</span></label>
      <div class="modal-actions"><button type="button" class="secondary" data-cancel>Cancel</button><button type="button" data-go disabled>Continue</button></div>`;
    const { close } = openModal(wrap);
    const go = wrap.querySelector("[data-go]");
    wrap.querySelector("#rights-ok").addEventListener("change", (e) => (go.disabled = !e.target.checked));
    wrap.querySelector("[data-cancel]").addEventListener("click", () => (close(), resolve(false)));
    go.addEventListener("click", () => {
      try {
        sessionStorage.setItem("rights-confirmed", "1");
      } catch {}
      close();
      resolve(true);
    });
  });
}

function loginScreen(message) {
  app.innerHTML = `
    <div class="page narrow">
      <img src="/crafter-engineering-logo-white.png" alt="Crafter Engineering" class="brand-logo" />
      <h1>${esc(info.name)}</h1>
      <p class="muted">${esc(message)}</p>
      <div id="login"></div>
      ${legalFooter()}
    </div>`;
  app.querySelector("#login").append(loginCard({ title: "Sign in to view files", onSuccess: () => location.reload() }));
}

async function start() {
  user = await loadMe().catch(() => null);
  if (user?.mustChange) return passwordChangeModal();

  // Scanning the project's QR code (or opening its link) brings a key in the address: swap it for a view-only session.
  let linkProblem = false;
  const key = new URLSearchParams(location.search).get("k");
  if (key) {
    try {
      await api(`${P}/link-session`, { method: "POST", json: { key } });
    } catch {
      linkProblem = true;
    }
    history.replaceState(null, "", location.pathname);
  }

  try {
    info = await api(P);
  } catch {
    shell(`<h1>Project not found</h1><p class="muted">This link doesn't match a project. Check that you copied the whole address.</p>`);
    return;
  }
  role = info.role;
  via = info.via;

  if (!role && !user) {
    return loginScreen(
      linkProblem
        ? "This project link has been replaced or is no longer valid. Ask for the new QR code or link, or sign in with your account."
        : "Project files are private. Sign in with the account you were given to continue."
    );
  }
  if (!role) {
    shell(`
      <h1>${esc(info.name)}</h1>
      <section class="card">
        <h2>You don't have access to this project</h2>
        <p>You're signed in as <strong>${esc(user.email)}</strong>, but this account hasn't been given access to this project.</p>
        <p class="muted">Ask a project administrator to add you, then reload this page.</p>
      </section>`);
    return;
  }

  await loadFiles();
  render();
}

async function loadFiles() {
  const data = await api(`${P}/files`);
  files = data.files;
  folders = data.folders;
  role = data.role;
  via = data.via;
  for (const id of [...selected]) if (!files.some((f) => f.id === id)) selected.delete(id);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!files.some((f) => f.status === "processing")) return;
  pollTimer = setTimeout(async () => {
    try {
      await loadFiles();
      renderFolders();
      schedulePoll();
    } catch {}
  }, 3000);
}

function render() {
  const isAdmin = can(role, "admin");
  const isDesigner = can(role, "designer");
  const badge =
    via === "link"
      ? `<span class="badge role-viewer">View only</span> <span class="muted small"> You're viewing with the project link. Sign in for more access.</span>`
      : `<span class="badge role-${esc(role)}" title="${esc(ROLE_HELP[role])}">${esc(ROLE_LABELS[role])} access</span> <span class="muted small"> ${esc(ROLE_HELP[role])}</span>`;
  shell(`
    <div class="page-head">
      <div>
        <h1>${esc(info.name)}</h1>
        ${info.description ? `<p class="muted">${esc(info.description)}</p>` : ""}
        ${badge}
      </div>
      <div class="head-actions">
        ${!user ? '<button type="button" id="sign-in">Sign in</button>' : ""}
        ${isDesigner ? '<button type="button" class="secondary" id="share">Link / QR</button>' : ""}
        ${isAdmin ? '<button type="button" class="secondary" id="rename-project">Rename</button>' : ""}
        ${user?.isAdmin ? '<button type="button" class="secondary danger" id="delete-project">Delete project</button>' : ""}
      </div>
    </div>
    ${isDesigner ? '<div class="send-bar card" id="send-bar"></div>' : ""}
    <div id="folders"></div>
    ${isDesigner ? '<section class="card" id="quick-card"></section><section class="card" id="access-card"></section>' : ""}
    ${isAdmin ? '<section class="card" id="activity-card"></section>' : ""}
  `);
  renderFolders();
  document.getElementById("sign-in")?.addEventListener("click", () => {
    const wrap = document.createElement("div");
    wrap.append(loginCard({ title: "Sign in", onSuccess: () => location.reload() }));
    openModal(wrap);
  });
  document.getElementById("share")?.addEventListener("click", showShare);
  document.getElementById("rename-project")?.addEventListener("click", renameProject);
  document.getElementById("delete-project")?.addEventListener("click", deleteProject);
  if (isDesigner) {
    renderQuickLinks();
    renderAccess();
  }
  if (isAdmin) renderActivityShell();
}

// ---------- folders & files ----------
function fileRow(f) {
  const viewable = f.type === "pdf" || (f.type === "ifc" && f.status === "ready");
  const viewUrl = f.type === "pdf" ? `/view/pdf/${f.id}` : `/view/ifc/${f.id}`;
  const status =
    f.status === "processing"
      ? '<span class="badge warn">Preparing 3D model…</span>'
      : f.status === "failed"
        ? `<span class="badge bad" title="${esc(f.error || "")}">Conversion failed</span>`
        : "";
  const actions = [];
  if (viewable) actions.push(`<a class="button secondary small" href="${viewUrl}">View</a>`);
  if (can(role, "client")) actions.push(`<a class="button secondary small" href="/api/files/${f.id}/download">Download</a>`);
  if (can(role, "designer")) {
    actions.push(`<button type="button" class="secondary small" data-action="replace" data-id="${f.id}">Replace</button>`);
    actions.push(`<button type="button" class="secondary small" data-action="rename" data-id="${f.id}">Rename</button>`);
    actions.push(`<button type="button" class="secondary small danger" data-action="delete" data-id="${f.id}">Delete</button>`);
  }
  const r = f.revision;
  const qrBadge = f.qr ? ' <span class="badge ok" title="This PDF has its QR code on it">QR ✓</span>' : "";
  const revBadges = qrBadge + (r
    ? r.superseded
      ? `<span class="badge rev" title="Revision ${esc(r.rev)}">${esc(r.rev)}</span> <span class="badge bad" title="The latest revision is ${esc(r.latestRev)}">Superseded by ${esc(r.latestRev)}</span>`
      : `<span class="badge rev" title="Revision ${esc(r.rev)}">${esc(r.rev)}</span> <span class="badge ok">Latest</span>`
    : "");
  // A drawing's link works for anyone who may see it; designers can also put its QR code onto the PDF.
  if (can(role, "designer") && (f.type === "pdf" || f.type === "ifc")) {
    if (f.type === "pdf" && f.revision && !f.qr) actions.push(`<button type="button" class="secondary small" data-action="addqr" data-id="${f.id}" title="Open the drawing and place its QR code">Add QR</button>`);
    actions.push(`<button type="button" class="secondary small" data-action="copylink" data-id="${f.id}" title="Copy the link that always opens the newest revision">Copy link</button>`);
  }
  return `
    <div class="file-row ${r?.superseded ? "superseded" : ""}">
      ${can(role, "designer") ? `<input type="checkbox" class="pick" data-pick="${f.id}" ${selected.has(f.id) ? "checked" : ""} aria-label="Select ${esc(f.name)} to send" />` : ""}
      <div class="file-main">
        <span class="file-name">${viewable ? `<a href="${viewUrl}">${esc(f.name)}</a>` : esc(f.name)} ${revBadges}</span>
        <span class="file-meta">${fmtSize(f.size)} · ${fmtDate(f.updated_at)}${f.uploaded_by ? ` · ${esc(f.uploaded_by)}` : ""}</span>
      </div>
      <div class="file-status">${status}</div>
      <div class="file-actions">${actions.join("")}</div>
    </div>`;
}

function renderSendBar() {
  const bar = document.getElementById("send-bar");
  if (!bar) return;
  const n = selected.size;
  bar.innerHTML = `
    <div>
      <strong>Send files to someone without an account</strong>
      <p class="muted small">Tick the files below, then create a link that works for 3 days. It only gives access to those files, not to the project.</p>
    </div>
    <button type="button" id="send-files" ${n ? "" : "disabled"}>${n ? `Send ${n} file${n === 1 ? "" : "s"}…` : "Select files to send"}</button>`;
  bar.querySelector("#send-files").addEventListener("click", showSend);
}

function renderFolders() {
  const host = document.getElementById("folders");
  if (hideOld === null) hideOld = !can(role, "designer");
  const oldCount = files.filter((f) => f.revision?.superseded).length;
  const controls = oldCount
    ? `<label class="check-line rev-toggle"><input type="checkbox" id="hide-old" ${hideOld ? "checked" : ""} /> <span>Hide superseded revisions <span class="muted">(${oldCount})</span></span></label>`
    : "";
  host.innerHTML = controls + folders
    .map((folder) => {
      const list = files.filter((f) => f.folder === folder.key && !(hideOld && f.revision?.superseded));
      return `
      <section class="card folder" data-folder="${folder.key}">
        <div class="folder-head">
          <div><h2>${esc(folder.label)} <span class="count">${list.length}</span></h2><p class="muted small">${esc(FOLDER_HINTS[folder.key] || "")}</p></div>
          ${folder.canUpload ? `<label class="button small">Upload<input type="file" ${FOLDER_ACCEPT[folder.key] ? `accept="${FOLDER_ACCEPT[folder.key]}"` : ""} multiple hidden data-upload="${folder.key}" /></label>` : ""}
        </div>
        <div class="upload-status" data-status="${folder.key}"></div>
        ${list.length ? list.map(fileRow).join("") : '<p class="muted empty-row">No files yet.</p>'}
      </section>`;
    })
    .join("");

  host.querySelector("#hide-old")?.addEventListener("change", (e) => {
    hideOld = e.target.checked;
    renderFolders();
  });
  host.querySelectorAll("[data-upload]").forEach((input) =>
    input.addEventListener("change", () => {
      uploadMany(input.dataset.upload, [...input.files]);
      input.value = "";
    })
  );
  host.querySelectorAll("[data-action]").forEach((button) =>
    button.addEventListener("click", () => fileAction(button.dataset.action, button.dataset.id))
  );
  host.querySelectorAll("[data-pick]").forEach((box) =>
    box.addEventListener("change", () => {
      if (box.checked) selected.add(box.dataset.pick);
      else selected.delete(box.dataset.pick);
      renderSendBar();
    })
  );
  if (can(role, "designer")) {
    host.querySelectorAll(".folder").forEach((section) => {
      section.addEventListener("dragover", (e) => {
        e.preventDefault();
        section.classList.add("dragging");
      });
      section.addEventListener("dragleave", () => section.classList.remove("dragging"));
      section.addEventListener("drop", (e) => {
        e.preventDefault();
        section.classList.remove("dragging");
        uploadMany(section.dataset.folder, [...e.dataTransfer.files]);
      });
    });
  }
  renderSendBar();
  schedulePoll();
}

async function uploadMany(folder, picked) {
  if (!picked.length || !(await confirmRights())) return;
  const status = document.querySelector(`[data-status="${folder}"]`);
  for (const file of picked) {
    status.textContent = `Uploading ${file.name}…`;
    try {
      const result = await uploadFile(`${P}/folders/${folder}/files?rights=1`, "POST", file, (p) => {
        status.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`;
      });
      if (result?.note) toast(result.note);
    } catch (err) {
      toast(err.message, "error");
    }
  }
  status.textContent = "";
  await loadFiles();
  renderFolders();
}

// Same reading of "name + space + revision code" as the server (the server is what actually enforces it).
function revisionParts(name) {
  const m = /^(.*\S)[\s_-]+([A-Za-z])(\d{2,3})$/.exec(name.replace(/\.[^.]+$/, ""));
  return m ? { base: m[1].trim().toLowerCase(), rev: `${m[2].toUpperCase()}${m[3]}` } : null;
}

// A "replace" whose new file is named as a different revision (or a different drawing) is almost always a new issue
// that should be uploaded as its own file, so the old revision is kept.
function askRevisionMismatch({ existing, incoming, canForce, message }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h3>This looks like a new revision</h3>
      <p>${esc(message)}</p>
      <p class="muted small">Existing file: <strong>${esc(existing)}</strong><br />New file: <strong>${esc(incoming)}</strong></p>
      <div class="modal-actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        ${canForce ? '<button type="button" class="secondary danger" data-force>Replace anyway</button>' : ""}
        <button type="button" data-new>Upload as a new file</button>
      </div>`;
    const { close } = openModal(wrap, { closable: false });
    const done = (value) => (close(), resolve(value));
    wrap.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    wrap.querySelector("[data-new]").addEventListener("click", () => done("new"));
    wrap.querySelector("[data-force]")?.addEventListener("click", () => done("force"));
  });
}

async function fileAction(action, id) {
  const file = files.find((f) => f.id === id);
  if (!file) return;
  if (action === "addqr") {
    location.href = `/view/pdf/${encodeURIComponent(id)}?qr=1`; // placed on the drawing itself, in the viewer
    return;
  }
  if (action === "copylink") {
    try {
      const link = await api(`/api/files/${encodeURIComponent(id)}/link`);
      await navigator.clipboard.writeText(link.url);
      toast("Link copied. It always opens the newest revision of this drawing.");
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Couldn't copy automatically." : err.message, "error");
    }
    return;
  }
  try {
    if (action === "delete") {
      if (!confirm(`Delete "${file.name}"? It goes to the SharePoint recycle bin.`)) return;
      await api(`/api/files/${id}`, { method: "DELETE" });
    } else if (action === "rename") {
      const name = prompt("New file name:", file.name);
      if (!name || name === file.name) return;
      try {
        await api(`/api/files/${id}`, { method: "PATCH", json: { name } });
      } catch (err) {
        if (err.data?.code !== "revision_mismatch") throw err;
        // Changing the revision code of an existing file is issuing a new revision: ask for a new upload instead.
        if (!err.data.canForce) return toast(err.message, "error");
        if (!confirm(`${err.message}

Rename anyway?`)) return;
        await api(`/api/files/${id}`, { method: "PATCH", json: { name, force: true } });
      }
    } else if (action === "replace") {
      const input = document.createElement("input");
      input.type = "file";
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
      if (ext) input.accept = ext;
      input.addEventListener("change", async () => {
        const chosen = input.files[0];
        if (!chosen || !(await confirmRights())) return;
        const status = document.querySelector(`[data-status="${file.folder}"]`);
        const progress = (label) => (p) => (status.textContent = `${label} ${chosen.name}… ${Math.round(p * 100)}%`);
        try {
          // Check the names first, so a big model isn't uploaded only to be turned down.
          const was = revisionParts(file.name);
          const now = revisionParts(chosen.name);
          let force = false;
          if (was && now && (was.rev !== now.rev || was.base !== now.base)) {
            const sameDrawing = was.base === now.base;
            const choice = await askRevisionMismatch({
              existing: file.name,
              incoming: chosen.name,
              canForce: can(role, "admin"),
              message: sameDrawing
                ? `You are replacing revision ${was.rev} with a file named as revision ${now.rev}. Replacing would overwrite ${was.rev} and lose it. Upload it as a new file instead, so both revisions are kept.`
                : "The new file looks like a different drawing, not a corrected copy of this one. Upload it as a new file instead.",
            });
            if (!choice) return;
            if (choice === "new") {
              const result = await uploadFile(`${P}/folders/${file.folder}/files?rights=1`, "POST", chosen, progress("Uploading"));
              toast(result?.note || `"${chosen.name}" uploaded as a new file.`);
              return;
            }
            force = true;
          }
          await uploadFile(`/api/files/${id}?rights=1${force ? "&force=1" : ""}`, "PUT", chosen, progress("Replacing"));
          toast(`"${file.name}" replaced with the new version.`);
        } catch (err) {
          toast(err.message, "error");
        } finally {
          status.textContent = "";
          await loadFiles();
          renderFolders();
        }
      });
      input.click();
      return;
    }
    selected.delete(id);
    await loadFiles();
    renderFolders();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- link / QR ----------
async function showShare() {
  let data;
  try {
    data = await api(`${P}/link`);
  } catch (err) {
    return toast(err.message, "error");
  }
  const wrap = document.createElement("div");
  const draw = (url, bust) => {
    wrap.innerHTML = `
      <h3>Project link and QR code</h3>
      <p class="muted">Anyone who scans this QR code or opens this link can <strong>view</strong> the folders marked public (never download, edit or see anything else), without signing in. People with accounts sign in as usual for more. Put the QR on site hoardings or drawings for workers.</p>
      <img class="qr" src="${P}/qr.png${bust ? `?v=${bust}` : ""}" alt="QR code for this project" />
      <div class="secret"><code>${esc(url)}</code><button type="button" class="secondary small" data-copy>Copy</button></div>
      <div class="modal-actions">
        <a class="button secondary" href="${P}/qr.png" download="project-qr.png">Download QR image</a>
        ${data.canReset ? '<button type="button" class="secondary danger" data-reset>Reset link</button>' : ""}
        <button type="button" data-close>Close</button>
      </div>
      ${data.canReset ? '<p class="muted small">Reset if the link or QR has been shared more widely than intended: the old ones stop working straight away and you will need to print the new QR.</p>' : ""}`;
    wrap.querySelector("[data-close]").addEventListener("click", close);
    wrap.querySelector("[data-copy]").addEventListener("click", async (e) => {
      await navigator.clipboard.writeText(url).catch(() => {});
      e.target.textContent = "Copied";
    });
    wrap.querySelector("[data-reset]")?.addEventListener("click", async () => {
      if (!confirm("Reset the project link? Existing QR codes and links stop working immediately.")) return;
      try {
        const result = await api(`${P}/link/reset`, { method: "POST" });
        draw(result.url, Date.now());
      } catch (err) {
        toast(err.message, "error");
      }
    });
  };
  const { close } = openModal(wrap);
  draw(data.url);
}

// ---------- quick-send links ----------
function showSend() {
  const chosen = files.filter((f) => selected.has(f.id));
  if (!chosen.length) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h3>Send ${chosen.length} file${chosen.length === 1 ? "" : "s"}</h3>
    <ul class="send-list">${chosen.map((f) => `<li>${esc(f.name)} <span class="muted small">${fmtSize(f.size)}</span></li>`).join("")}</ul>
    <label>Message (optional)<textarea name="message" rows="3" maxlength="500" placeholder="e.g. Latest drawings for your review"></textarea></label>
    <p class="muted small"><strong>Only send files we have the right to share</strong> (check for other companies’ drawings, map data, etc.). Anyone you give the link to can download these files, as many times as they like, for 3 days. The link doesn't give access to the project or any other file, and you can cancel it at any time.</p>
    <p class="error" id="send-error"></p>
    <div class="modal-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" data-create>Create link</button></div>`;
  const { close } = openModal(wrap);
  wrap.querySelector("[data-close]").addEventListener("click", close);
  wrap.querySelector("[data-create]").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const result = await api(`${P}/shares`, {
        method: "POST",
        json: { files: chosen.map((f) => f.id), message: wrap.querySelector("textarea").value },
      });
      selected.clear();
      renderFolders();
      renderQuickLinks();
      wrap.innerHTML = `
        <h3>Your link is ready</h3>
        <div class="secret"><code>${esc(result.url)}</code><button type="button" class="secondary small" data-copy>Copy</button></div>
        <p class="muted small">Works until ${esc(fmtDate(result.expiresAt))}. For security the address is only shown now. If you lose it, create a new link.</p>
        <div class="modal-actions"><button type="button" data-close>Done</button></div>`;
      wrap.querySelector("[data-close]").addEventListener("click", close);
      wrap.querySelector("[data-copy]").addEventListener("click", async (e) => {
        await navigator.clipboard.writeText(result.url).catch(() => {});
        e.target.textContent = "Copied";
      });
    } catch (err) {
      wrap.querySelector("#send-error").textContent = err.message;
      event.target.disabled = false;
    }
  });
}

async function renderQuickLinks() {
  const card = document.getElementById("quick-card");
  if (!card) return;
  const links = await api(`${P}/shares`).catch(() => []);
  card.innerHTML = `
    <h2>Active quick links</h2>
    ${
      links.length
        ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Sent by</th><th>Files</th><th>Message</th><th>Expires</th><th></th></tr></thead>
        <tbody>${links
          .map(
            (l) => `<tr>
          <td>${esc(l.created_by_name || "—")}</td><td>${l.files}</td><td>${esc(l.message || "")}</td><td>${esc(fmtDate(l.expires_at))}</td>
          <td><button type="button" class="secondary small danger" data-cancel="${l.id}">Cancel link</button></td></tr>`
          )
          .join("")}</tbody></table></div>`
        : '<p class="muted">No active links. Tick files above to send some.</p>'
    }`;
  card.querySelectorAll("[data-cancel]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Cancel this link? The people you sent it to will no longer be able to download the files.")) return;
      try {
        await api(`${P}/shares/${button.dataset.cancel}`, { method: "DELETE" });
        renderQuickLinks();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
}

async function renameProject() {
  const name = prompt("Project name:", info.name);
  if (!name || name === info.name) return;
  try {
    await api(P, { method: "PATCH", json: { name } });
    location.reload();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteProject() {
  const typed = prompt(`This removes the project from this site and ends everyone's access to it. The files themselves stay where they are in SharePoint.\n\nType the project name to confirm:\n${info.name}`);
  if (typed !== info.name) return;
  try {
    await api(P, { method: "DELETE" });
    location.href = "/";
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- access (stored in the project's Excel access register) ----------
async function renderAccess() {
  const card = document.getElementById("access-card");
  if (!card) return;
  let data;
  try {
    data = await api(`${P}/access`);
  } catch (err) {
    card.innerHTML = `<h2>Access</h2><p class="error">${esc(err.message)}</p>`;
    return;
  }
  const isAdmin = data.canManagePeople;
  const directory = isAdmin ? await api(`${P}/directory`).catch(() => []) : [];
  const folderCols = data.folders;
  const roleOptions = (selected) =>
    Object.keys(ROLE_LABELS)
      .map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${ROLE_LABELS[r]}</option>`)
      .join("");

  const note = `<p class="muted small">This list lives in <strong>${esc(data.registerName)}</strong> in the project's Submissions folder in SharePoint. You can change it here or open that Excel file and edit it directly; both change the same file (the site picks up manual edits within about 15 seconds).</p>`;

  if (data.error || data.missing) {
    card.innerHTML = `<h2>Access</h2>
      <p class="error">${data.missing ? `The access file (${esc(data.registerName)}) is missing from the Submissions folder, so nobody but site administrators can open this project.` : esc(data.error)}</p>
      ${data.missing && isAdmin ? '<button type="button" id="repair">Create a new access file</button>' : '<p class="muted small">Ask an administrator to fix the file in SharePoint.</p>'}`;
    card.querySelector("#repair")?.addEventListener("click", async () => {
      try {
        await api(`${P}/access/repair`, { method: "POST" });
        renderAccess();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    return;
  }

  const check = (on, attrs) => `<td class="check-cell"><input type="checkbox" ${on ? "checked" : ""} ${attrs} /></td>`;
  card.innerHTML = `
    <h2>Who can see what</h2>
    ${note}
    <ul class="role-legend">${Object.keys(ROLE_LABELS)
      .map((r) => `<li><span class="badge role-${r}">${ROLE_LABELS[r]}</span> ${esc(ROLE_HELP[r])}</li>`)
      .join("")}</ul>
    ${data.warnings.length ? `<ul class="warn-list">${data.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <div class="table-wrap"><table class="table access-table">
      <thead><tr><th>Person</th><th>Role</th>${folderCols.map((f) => `<th class="check-cell">${esc(f.label)}</th>`).join("")}<th></th></tr></thead>
      <tbody>
        <tr class="public-row">
          <td colspan="2"><strong>Anyone with the link or QR code</strong><br /><span class="muted small">No sign-in, view only. Everyone on the project can see these folders too.</span></td>
          ${folderCols.map((f) => check(data.publicFolders[f.key], `data-public="${f.key}"`)).join("")}
          <td></td>
        </tr>
        ${data.people
          .map((p) => {
            const all = p.role === "designer" || p.role === "admin";
            return `<tr>
              <td>${esc(p.name || p.email)}${p.disabled ? ' <span class="badge bad">Disabled</span>' : ""}${!p.hasAccount ? ' <span class="badge warn">No account yet</span>' : ""}<br /><span class="muted small">${esc(p.email)}</span></td>
              <td>${isAdmin ? `<select data-role="${esc(p.email)}">${roleOptions(p.role)}</select>` : esc(ROLE_LABELS[p.role])}</td>
              ${folderCols.map((f) => check(all || p.folders[f.key], `${all ? "disabled" : ""} data-person="${esc(p.email)}" data-folder="${f.key}"`)).join("")}
              <td>${!p.hasAccount && isAdmin ? `<button type="button" class="secondary small" data-create="${esc(p.email)}">Create account</button> ` : ""}${isAdmin ? `<button type="button" class="secondary small danger" data-remove="${esc(p.email)}">Remove</button>` : ""}</td>
            </tr>`;
          })
          .join("") || `<tr><td colspan="${folderCols.length + 3}" class="muted">Nobody has been given access yet.</td></tr>`}
      </tbody>
    </table></div>
    <p class="muted small">Designers and admins always see every folder.</p>
    ${
      isAdmin
        ? `<h3>Give someone access</h3>
    <form id="add-member" class="inline-form">
      <label>Person
        <select name="person">
          ${directory.length ? '<option value="">Choose a registered person…</option>' : ""}
          ${directory.map((d) => `<option value="${esc(d.email)}">${esc(d.name)} (${esc(d.email)})</option>`).join("")}
          <option value="__new__" ${directory.length ? "" : "selected"}>＋ Add a new person…</option>
        </select>
      </label>
      <span id="new-person" class="new-person ${directory.length ? "hidden" : ""}">
        <label>Email<input type="email" name="email" /></label>
        <label>Name<input name="name" maxlength="120" /></label>
      </span>
      <label>Role<select name="role">${roleOptions("client")}</select></label>
      <button type="submit">Give access</button>
    </form>
    <p class="muted small">Pick someone who already has an account, or add a new person: an account is created with a temporary password for you to pass on. New viewers and clients start with the public folders; tick more above.</p>
    <p class="error" id="member-error"></p>`
        : ""
    }`;

  const save = async (promise) => {
    try {
      await promise;
    } catch (err) {
      toast(err.message, "error");
    }
    renderAccess();
  };
  card.querySelectorAll("[data-public]").forEach((box) =>
    box.addEventListener("change", () => save(api(`${P}/access/public`, { method: "PUT", json: { folders: { [box.dataset.public]: box.checked } } })))
  );
  card.querySelectorAll("[data-person]").forEach((box) =>
    box.addEventListener("change", () =>
      save(api(`${P}/access/people/${encodeURIComponent(box.dataset.person)}/folders`, { method: "PUT", json: { folders: { [box.dataset.folder]: box.checked } } }))
    )
  );
  card.querySelectorAll("[data-role]").forEach((select) =>
    select.addEventListener("change", () => save(api(`${P}/members/${encodeURIComponent(select.dataset.role)}`, { method: "PATCH", json: { role: select.value } })))
  );
  card.querySelectorAll("[data-remove]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!confirm(`Remove ${button.dataset.remove} from this project?`)) return;
      save(api(`${P}/members/${encodeURIComponent(button.dataset.remove)}`, { method: "DELETE" }));
    })
  );
  card.querySelectorAll("[data-create]").forEach((button) =>
    button.addEventListener("click", async () => {
      const person = data.people.find((p) => p.email === button.dataset.create);
      try {
        // Granting again creates the missing account and returns its temporary password.
        const result = await api(`${P}/members`, { method: "POST", json: { email: person.email, name: person.name, role: person.role, folders: person.folders } });
        renderAccess();
        if (result.tempPassword) showSecret({ title: `Account created for ${person.email}`, intro: "Their temporary password:", secret: result.tempPassword });
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
  const addForm = card.querySelector("#add-member");
  if (addForm) {
    const newFields = addForm.querySelector("#new-person");
    const sync = () => {
      const isNew = addForm.person.value === "__new__";
      newFields.classList.toggle("hidden", !isNew);
      addForm.email.required = isNew;
    };
    addForm.person.addEventListener("change", sync);
    sync();
    addForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const isNew = addForm.person.value === "__new__";
      const email = isNew ? addForm.email.value : addForm.person.value;
      if (!email) {
        card.querySelector("#member-error").textContent = "Choose a person, or add a new one.";
        return;
      }
      try {
        const result = await api(`${P}/members`, { method: "POST", json: { email, name: isNew ? addForm.name.value : undefined, role: addForm.role.value } });
        await renderAccess();
        if (result.tempPassword) {
          showSecret({ title: `Account created for ${result.member.email}`, intro: "Their temporary password:", secret: result.tempPassword });
        } else toast(`${result.member.email} now has ${ROLE_LABELS[result.member.role]} access.`);
      } catch (err) {
        card.querySelector("#member-error").textContent = err.message;
      }
    });
  }
}

// ---------- activity (project admins) ----------
const ACTIONS = {
  login: "signed in",
  login_failed: "failed sign-in",
  file_uploaded: "uploaded",
  file_replaced: "replaced",
  file_renamed: "renamed",
  file_deleted: "deleted",
  file_viewed: "viewed",
  file_downloaded: "downloaded",
  access_granted: "granted access",
  access_removed: "removed access",
  role_changed: "changed role",
  folder_access_changed: "changed folder access",
  public_folders_changed: "changed what the link/QR shows",
  link_reset: "reset the project link",
  share_created: "created a quick link",
  share_cancelled: "cancelled a quick link",
  share_downloaded: "quick-link download",
  register_repaired: "created a new access file",
  project_updated: "updated the project",
  user_created: "created an account",
};

function renderActivityShell() {
  const card = document.getElementById("activity-card");
  card.innerHTML = `<div class="folder-head"><h2>Activity</h2><div class="head-actions"><button type="button" class="secondary small hidden" id="refresh-activity">Refresh</button><button type="button" class="secondary small" id="toggle-activity">Show recent activity</button></div></div><div id="activity-list"></div>`;
  const list = card.querySelector("#activity-list");
  const toggle = card.querySelector("#toggle-activity");
  const refresh = card.querySelector("#refresh-activity");
  let shown = false;

  async function load() {
    const rows = await api(`${P}/activity`).catch((err) => (toast(err.message, "error"), []));
    list.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr><td>${fmtDate(r.ts)}</td><td>${esc(r.user_name || r.user_email || "—")}</td><td>${esc(ACTIONS[r.action] || r.action)}${r.detail ? ` — ${esc(r.detail)}` : ""}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : '<p class="muted">Nothing yet.</p>';
  }

  toggle.addEventListener("click", async () => {
    shown = !shown;
    list.classList.toggle("hidden", !shown);
    refresh.classList.toggle("hidden", !shown);
    toggle.textContent = shown ? "Hide activity" : "Show recent activity";
    if (shown) await load();
  });
  refresh.addEventListener("click", load);
}

start();
