// Shared helpers for every page.

export const $ = (selector, root = document) => root.querySelector(selector);

export function esc(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML.replace(/"/g, "&quot;");
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export async function api(url, { method = "GET", json, form } = {}) {
  const headers = { "X-Requested-With": "ifc-viewer" };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(url, { method, headers, body, credentials: "same-origin" });
  let data = null;
  if (res.status !== 204 && (res.headers.get("content-type") || "").includes("json")) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

export function uploadFile(url, method, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("X-Requested-With", "ifc-viewer");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new Error(data?.error || "Upload failed.");
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function loadMe() {
  const { user } = await api("/api/auth/me");
  return user;
}

export function openModal(element, { closable = true } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const box = document.createElement("div");
  box.className = "modal-content modal-left";
  box.append(element);
  overlay.append(box);
  document.body.append(overlay);
  const close = () => overlay.remove();
  if (closable) overlay.addEventListener("click", (e) => e.target === overlay && close());
  return { box, close };
}

export function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

export function showSecret({ title, intro, secret }) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h3>${esc(title)}</h3>
    <p>${esc(intro)}</p>
    <div class="secret"><code>${esc(secret)}</code><button type="button" class="secondary small" data-copy>Copy</button></div>
    <p class="hint">This is shown only once. Share it securely — they will be asked to choose their own password when they first sign in.</p>
    <button type="button" data-close>Done</button>`;
  const { close } = openModal(wrap, { closable: false });
  wrap.querySelector("[data-copy]").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(secret);
      e.target.textContent = "Copied";
    } catch {
      e.target.textContent = "Copy failed";
    }
  });
  wrap.querySelector("[data-close]").addEventListener("click", close);
}

export function topbarHtml(user) {
  return `
    <header class="topbar">
      <a class="brand" href="/"><img src="/favicon.png" alt="" /><span>Crafter Engineering</span></a>
      <nav>
        ${user?.isAdmin ? '<a href="/admin">Admin</a>' : ""}
        ${user ? `<span class="who">${esc(user.name)}</span><button type="button" class="secondary small" data-signout>Sign out</button>` : ""}
      </nav>
    </header>`;
}

export function wireTopbar(root, { afterSignOut } = {}) {
  root.querySelector("[data-signout]")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    if (afterSignOut) afterSignOut();
    else location.href = "/";
  });
}

export function loginCard({ title, onSuccess }) {
  const card = document.createElement("section");
  card.className = "card login-card";
  card.innerHTML = `
    <h2>${esc(title)}</h2>
    <form>
      <label>Email<input type="email" name="email" autocomplete="username" required /></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
      <button type="submit">Sign in</button>
    </form>
    <p class="error"></p>`;
  const form = card.querySelector("form");
  const error = card.querySelector(".error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const { user } = await api("/api/auth/login", {
        method: "POST",
        json: { email: form.email.value, password: form.password.value },
      });
      onSuccess(user);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
  return card;
}

// Blocks the page until a user with a temporary password chooses their own.
export function passwordChangeModal() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <h3>Choose your own password</h3>
    <p>You're signed in with a temporary password. Please set a new one (at least 10 characters) to continue.</p>
    <form>
      <label>Temporary password<input type="password" name="current" autocomplete="current-password" required /></label>
      <label>New password<input type="password" name="next" autocomplete="new-password" minlength="10" required /></label>
      <label>Repeat new password<input type="password" name="again" autocomplete="new-password" minlength="10" required /></label>
      <button type="submit">Save password</button>
    </form>
    <p class="error"></p>`;
  openModal(wrap, { closable: false });
  const form = wrap.querySelector("form");
  const error = wrap.querySelector(".error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (form.next.value !== form.again.value) {
      error.textContent = "The new passwords don't match.";
      return;
    }
    try {
      await api("/api/auth/change-password", { method: "POST", json: { current: form.current.value, next: form.next.value } });
      location.reload();
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

export const ROLE_LABELS = {
  viewer: "Viewer",
  client: "Client",
  designer: "Designer",
  admin: "Admin",
};

export const ROLE_HELP = {
  viewer: "View PDFs and IFC models only. No downloads.",
  client: "View and download files.",
  designer: "View, download, upload, replace, rename and delete files. Decide who sees which folder and send quick links.",
  admin: "Everything a Designer can do, plus manage who has access.",
};

// "New project" form, shared by the dashboard and the admin page. With SharePoint storage a project is a folder there.
export function newProjectFormHtml(kind) {
  const sharepoint = kind === "sharepoint";
  return `
    ${
      sharepoint
        ? `<label>SharePoint folder (address, or the code from IT)<input name="sharepointUrl" required maxlength="2000" placeholder="https://crafterengineering.sharepoint.com/…/4 – Submissions" /></label>
           <label>Name (optional, defaults to the folder name)<input name="name" maxlength="120" /></label>`
        : '<label>Name<input name="name" required maxlength="120" placeholder="e.g. 100180 – Shady Lane Car Port" /></label>'
    }
    <label>Description (optional)<input name="description" maxlength="500" /></label>
    <button type="submit">Create project</button>`;
}

export const newProjectPayload = (form) => ({
  name: form.name.value,
  description: form.description.value,
  sharepointUrl: form.sharepointUrl?.value,
});
