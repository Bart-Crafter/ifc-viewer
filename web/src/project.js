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

const FOLDERS = [
  { key: "pdf", title: "PDF", hint: "Drawings and documents you can view in the browser" },
  { key: "dwg", title: "DWG", hint: "CAD drawings — download only" },
  { key: "ifc", title: "IFC", hint: "3D models you can view in the browser" },
];

let user = null;
let info = null;
let role = null;
let files = [];
let pollTimer = null;

function shell(inner) {
  app.innerHTML = `${topbarHtml(user)}<div class="page">${inner}</div>`;
  wireTopbar(app, { afterSignOut: () => location.reload() });
}

async function start() {
  user = await loadMe().catch(() => null);
  if (user?.mustChange) return passwordChangeModal();
  try {
    info = await api(`/api/projects/${encodeURIComponent(pid)}`);
  } catch (err) {
    shell(`<h1>Project not found</h1><p class="muted">This link doesn't match a project. Check that you copied the whole address.</p>`);
    return;
  }
  role = info.role;

  if (!user) {
    app.innerHTML = `
      <div class="page narrow">
        <img src="/crafter-engineering-logo.png" alt="Crafter Engineering" class="brand-logo" />
        <h1>${esc(info.name)}</h1>
        <p class="muted">Project files are private. Sign in with the account you were given to continue.</p>
        <div id="login"></div>
      </div>`;
    app.querySelector("#login").append(loginCard({ title: "Sign in to view files", onSuccess: () => location.reload() }));
    return;
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
  const data = await api(`/api/projects/${encodeURIComponent(pid)}/files`);
  files = data.files;
  role = data.role;
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
  shell(`
    <div class="page-head">
      <div>
        <h1>${esc(info.name)}</h1>
        ${info.description ? `<p class="muted">${esc(info.description)}</p>` : ""}
        <span class="badge role-${esc(role)}" title="${esc(ROLE_HELP[role])}">${esc(ROLE_LABELS[role])} access</span>
        <span class="muted small"> ${esc(ROLE_HELP[role])}</span>
      </div>
      <div class="head-actions">
        <button type="button" class="secondary" id="share">Share link / QR</button>
        ${isAdmin ? '<button type="button" class="secondary" id="rename-project">Rename</button>' : ""}
        ${user.isAdmin ? '<button type="button" class="secondary danger" id="delete-project">Delete project</button>' : ""}
      </div>
    </div>
    <div id="folders"></div>
    ${isAdmin ? '<section class="card" id="members-card"></section><section class="card" id="activity-card"></section>' : ""}
  `);
  renderFolders();
  document.getElementById("share").addEventListener("click", showShare);
  document.getElementById("rename-project")?.addEventListener("click", renameProject);
  document.getElementById("delete-project")?.addEventListener("click", deleteProject);
  if (isAdmin) {
    renderMembers();
    renderActivityShell();
  }
}

// ---------- folders & files ----------
function fileRow(f) {
  const viewable = f.folder === "pdf" || (f.folder === "ifc" && f.status === "ready");
  const viewUrl = f.folder === "pdf" ? `/view/pdf/${f.id}` : `/view/ifc/${f.id}`;
  const status =
    f.status === "processing"
      ? '<span class="badge warn">Preparing 3D model…</span>'
      : f.status === "failed"
        ? `<span class="badge bad" title="${esc(f.error || "")}">Conversion failed</span>`
        : "";
  const actions = [];
  if (viewable) actions.push(`<a class="button secondary small" href="${viewUrl}">View</a>`);
  if (can(role, "client")) actions.push(`<a class="button secondary small" href="/api/files/${f.id}/download">Download</a>`);
  else if (f.folder === "dwg") actions.push('<span class="muted small">Download needs Client access</span>');
  if (can(role, "designer")) {
    actions.push(`<button type="button" class="secondary small" data-action="replace" data-id="${f.id}">Replace</button>`);
    actions.push(`<button type="button" class="secondary small" data-action="rename" data-id="${f.id}">Rename</button>`);
    actions.push(`<button type="button" class="secondary small danger" data-action="delete" data-id="${f.id}">Delete</button>`);
  }
  return `
    <div class="file-row">
      <div class="file-main">
        <span class="file-name">${viewable ? `<a href="${viewUrl}">${esc(f.name)}</a>` : esc(f.name)}</span>
        <span class="file-meta">${fmtSize(f.size)} · ${fmtDate(f.updated_at)}${f.uploaded_by ? ` · ${esc(f.uploaded_by)}` : ""}</span>
      </div>
      <div class="file-status">${status}</div>
      <div class="file-actions">${actions.join("")}</div>
    </div>`;
}

function renderFolders() {
  const host = document.getElementById("folders");
  host.innerHTML = FOLDERS.map((folder) => {
    const list = files.filter((f) => f.folder === folder.key);
    return `
      <section class="card folder" data-folder="${folder.key}">
        <div class="folder-head">
          <div><h2>${folder.title} <span class="count">${list.length}</span></h2><p class="muted small">${esc(folder.hint)}</p></div>
          ${can(role, "designer") ? `<label class="button small">Upload ${folder.title}<input type="file" accept=".${folder.key}" multiple hidden data-upload="${folder.key}" /></label>` : ""}
        </div>
        <div class="upload-status" data-status="${folder.key}"></div>
        ${list.length ? list.map(fileRow).join("") : '<p class="muted empty-row">No files yet.</p>'}
      </section>`;
  }).join("");

  host.querySelectorAll("[data-upload]").forEach((input) =>
    input.addEventListener("change", () => {
      uploadMany(input.dataset.upload, [...input.files]);
      input.value = "";
    })
  );
  host.querySelectorAll("[data-action]").forEach((button) =>
    button.addEventListener("click", () => fileAction(button.dataset.action, button.dataset.id))
  );
  can(role, "designer") &&
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
  schedulePoll();
}

async function uploadMany(folder, picked) {
  const status = document.querySelector(`[data-status="${folder}"]`);
  for (const file of picked) {
    if (!file.name.toLowerCase().endsWith(`.${folder}`)) {
      toast(`"${file.name}" isn't a .${folder} file — it can't go in the ${folder.toUpperCase()} folder.`, "error");
      continue;
    }
    status.textContent = `Uploading ${file.name}…`;
    try {
      await uploadFile(`/api/projects/${encodeURIComponent(pid)}/files`, "POST", file, (p) => {
        status.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`;
      });
    } catch (err) {
      toast(err.message, "error");
    }
  }
  status.textContent = "";
  await loadFiles();
  renderFolders();
}

async function fileAction(action, id) {
  const file = files.find((f) => f.id === id);
  if (!file) return;
  try {
    if (action === "delete") {
      if (!confirm(`Delete "${file.name}"? This can't be undone.`)) return;
      await api(`/api/files/${id}`, { method: "DELETE" });
    } else if (action === "rename") {
      const name = prompt("New file name:", file.name);
      if (!name || name === file.name) return;
      await api(`/api/files/${id}`, { method: "PATCH", json: { name } });
    } else if (action === "replace") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = `.${file.folder}`;
      input.addEventListener("change", async () => {
        if (!input.files[0]) return;
        const status = document.querySelector(`[data-status="${file.folder}"]`);
        try {
          await uploadFile(`/api/files/${id}`, "PUT", input.files[0], (p) => {
            status.textContent = `Replacing ${file.name}… ${Math.round(p * 100)}%`;
          });
          toast(`"${file.name}" replaced with the new version.`);
        } catch (err) {
          toast(err.message, "error");
        }
        status.textContent = "";
        await loadFiles();
        renderFolders();
      });
      input.click();
      return;
    }
    await loadFiles();
    renderFolders();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- share / QR ----------
function showShare() {
  const link = `${location.origin}/p/${pid}`;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h3>Share this project</h3>
    <p class="muted">Anyone with this link or QR code lands on this project's sign-in page. Only people who have been given access can see any files.</p>
    <img class="qr" src="/api/projects/${encodeURIComponent(pid)}/qr.png" alt="QR code for this project" />
    <div class="secret"><code>${esc(link)}</code><button type="button" class="secondary small" data-copy>Copy</button></div>
    <div class="modal-actions">
      <a class="button secondary" href="/api/projects/${encodeURIComponent(pid)}/qr.png" download="project-qr.png">Download QR image</a>
      <button type="button" data-close>Close</button>
    </div>`;
  const { close } = openModal(wrap);
  wrap.querySelector("[data-close]").addEventListener("click", close);
  wrap.querySelector("[data-copy]").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(link).catch(() => {});
    e.target.textContent = "Copied";
  });
}

async function renameProject() {
  const name = prompt("Project name:", info.name);
  if (!name || name === info.name) return;
  try {
    await api(`/api/projects/${encodeURIComponent(pid)}`, { method: "PATCH", json: { name } });
    location.reload();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteProject() {
  const typed = prompt(`This removes the project from this site and ends everyone's access to it. The files themselves stay where they are in SharePoint.\n\nType the project name to confirm:\n${info.name}`);
  if (typed !== info.name) return;
  try {
    await api(`/api/projects/${encodeURIComponent(pid)}`, { method: "DELETE" });
    location.href = "/";
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- members (project admins) ----------
async function renderMembers() {
  const card = document.getElementById("members-card");
  const members = await api(`/api/projects/${encodeURIComponent(pid)}/members`);
  const roleOptions = (selected) =>
    Object.keys(ROLE_LABELS)
      .map((r) => `<option value="${r}" ${r === selected ? "selected" : ""}>${ROLE_LABELS[r]}</option>`)
      .join("");

  card.innerHTML = `
    <h2>People with access</h2>
    <ul class="role-legend">${Object.keys(ROLE_LABELS)
      .map((r) => `<li><span class="badge role-${r}">${ROLE_LABELS[r]}</span> ${esc(ROLE_HELP[r])}</li>`)
      .join("")}</ul>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>
        ${members
          .map(
            (m) => `<tr>
              <td>${esc(m.name)}${m.disabled ? ' <span class="badge bad">Disabled</span>' : ""}</td>
              <td>${esc(m.email)}</td>
              <td><select data-role="${m.id}">${roleOptions(m.role)}</select></td>
              <td><button type="button" class="secondary small danger" data-remove="${m.id}">Remove access</button></td>
            </tr>`
          )
          .join("") || '<tr><td colspan="4" class="muted">Nobody has been given access yet.</td></tr>'}
      </tbody>
    </table></div>
    <h3>Give someone access</h3>
    <form id="add-member" class="inline-form">
      <label>Email<input type="email" name="email" required /></label>
      <label>Name (for new accounts)<input name="name" maxlength="120" /></label>
      <label>Role<select name="role">${roleOptions("client")}</select></label>
      <button type="submit">Give access</button>
    </form>
    <p class="muted small">If the email doesn't have an account yet, one is created with a temporary password for you to pass on.</p>
    <p class="error" id="member-error"></p>`;

  card.querySelectorAll("[data-role]").forEach((select) =>
    select.addEventListener("change", async () => {
      try {
        await api(`/api/projects/${encodeURIComponent(pid)}/members/${select.dataset.role}`, { method: "PATCH", json: { role: select.value } });
        toast("Role updated.");
      } catch (err) {
        toast(err.message, "error");
        renderMembers();
      }
    })
  );
  card.querySelectorAll("[data-remove]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Remove this person's access to the project?")) return;
      try {
        await api(`/api/projects/${encodeURIComponent(pid)}/members/${button.dataset.remove}`, { method: "DELETE" });
        renderMembers();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
  card.querySelector("#add-member").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(pid)}/members`, {
        method: "POST",
        json: { email: form.email.value, name: form.name.value, role: form.role.value },
      });
      await renderMembers();
      if (result.tempPassword) {
        showSecret({
          title: `Account created for ${result.member.email}`,
          intro: "Their temporary password:",
          secret: result.tempPassword,
        });
      } else toast(`${result.member.email} now has ${ROLE_LABELS[result.member.role]} access.`);
    } catch (err) {
      card.querySelector("#member-error").textContent = err.message;
    }
  });
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
  project_updated: "updated the project",
  user_created: "created an account",
};

function renderActivityShell() {
  const card = document.getElementById("activity-card");
  card.innerHTML = `<div class="folder-head"><h2>Activity</h2><button type="button" class="secondary small" id="load-activity">Show recent activity</button></div><div id="activity-list"></div>`;
  card.querySelector("#load-activity").addEventListener("click", async (event) => {
    const rows = await api(`/api/projects/${encodeURIComponent(pid)}/activity`).catch((err) => (toast(err.message, "error"), []));
    card.querySelector("#activity-list").innerHTML = rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr><td>${fmtDate(r.ts)}</td><td>${esc(r.user_name || r.user_email || "—")}</td><td>${esc(ACTIONS[r.action] || r.action)}${r.detail ? ` — ${esc(r.detail)}` : ""}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : '<p class="muted">Nothing yet.</p>';
    event.target.textContent = "Refresh";
  });
}

start();
