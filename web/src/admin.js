import { api, esc, fmtDate, loadMe, loginCard, newProjectFormHtml, newProjectPayload, passwordChangeModal, showSecret, toast, topbarHtml, wireTopbar } from "./common.js";

const app = document.getElementById("app");
let me = null;

async function render() {
  const [users, projects, storage] = await Promise.all([api("/api/admin/users"), api("/api/projects"), api("/api/storage")]);
  const storageKind = storage.kind;
  app.innerHTML = `
    ${topbarHtml(me)}
    <div class="page">
      <h1>Administration</h1>

      <section class="card">
        <h2>Accounts</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Projects</th><th></th></tr></thead>
          <tbody>
            ${users
              .map(
                (u) => `<tr>
                  <td>${esc(u.name)}</td>
                  <td>${esc(u.email)}</td>
                  <td>
                    ${u.isAdmin ? '<span class="badge role-admin">Site admin</span> ' : ""}
                    ${u.disabled ? '<span class="badge bad">Disabled</span> ' : ""}
                    ${u.mustChange ? '<span class="badge warn" title="Hasn\'t chosen their own password yet">Temp password</span>' : ""}
                  </td>
                  <td>${u.projects}</td>
                  <td class="row-actions">
                    <button type="button" class="secondary small" data-act="reset" data-id="${u.id}">Reset password</button>
                    <button type="button" class="secondary small" data-act="${u.disabled ? "enable" : "disable"}" data-id="${u.id}" ${u.id === me.id ? "disabled" : ""}>${u.disabled ? "Enable" : "Disable"}</button>
                    <button type="button" class="secondary small" data-act="${u.isAdmin ? "demote" : "promote"}" data-id="${u.id}" ${u.id === me.id ? "disabled" : ""}>${u.isAdmin ? "Remove site admin" : "Make site admin"}</button>
                    <button type="button" class="secondary small danger" data-act="delete" data-id="${u.id}" ${u.id === me.id ? "disabled" : ""}>Delete</button>
                  </td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table></div>
        <h3>Create an account</h3>
        <form id="new-user" class="inline-form">
          <label>Email<input type="email" name="email" required /></label>
          <label>Name<input name="name" maxlength="120" /></label>
          <label class="check"><input type="checkbox" name="isAdmin" /> Site administrator</label>
          <button type="submit">Create account</button>
        </form>
        <p class="muted small">A temporary password is generated and shown once. They must change it when they first sign in. Give people project access from each project's page.</p>
        <p class="error" id="user-error"></p>
      </section>

      <section class="card">
        <h2>Projects</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th></th></tr></thead>
          <tbody>${projects.map((p) => `<tr><td>${esc(p.name)}</td><td class="row-actions"><a class="button secondary small" href="/p/${esc(p.id)}">Open</a></td></tr>`).join("") || '<tr><td colspan="2" class="muted">No projects yet.</td></tr>'}</tbody>
        </table></div>
        <h3>New project</h3>
        <form id="new-project" class="inline-form">
          ${newProjectFormHtml(storageKind)}
        </form>
        <p class="error" id="project-error"></p>
      </section>
    </div>`;
  wireTopbar(app);

  app.querySelector("#new-user").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const result = await api("/api/admin/users", {
        method: "POST",
        json: { email: form.email.value, name: form.name.value, isAdmin: form.isAdmin.checked },
      });
      await render();
      showSecret({ title: `Account created for ${result.user.email}`, intro: "Their temporary password:", secret: result.tempPassword });
    } catch (err) {
      app.querySelector("#user-error").textContent = err.message;
    }
  });

  app.querySelector("#new-project").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const project = await api("/api/projects", { method: "POST", json: newProjectPayload(form) });
      location.href = `/p/${project.id}`;
    } catch (err) {
      app.querySelector("#project-error").textContent = err.message;
    }
  });

  app.querySelectorAll("[data-act]").forEach((button) =>
    button.addEventListener("click", async () => {
      const user = users.find((u) => u.id === button.dataset.id);
      const act = button.dataset.act;
      try {
        if (act === "delete") {
          if (!confirm(`Delete the account for ${user.email}? They lose access to every project.`)) return;
          await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
        } else if (act === "reset") {
          if (!confirm(`Reset the password for ${user.email}? They'll be signed out everywhere.`)) return;
          const result = await api(`/api/admin/users/${user.id}`, { method: "PATCH", json: { resetPassword: true } });
          await render();
          showSecret({ title: `New temporary password for ${user.email}`, intro: "Their temporary password:", secret: result.tempPassword });
          return;
        } else {
          const json = { disable: { disabled: true }, enable: { disabled: false }, promote: { isAdmin: true }, demote: { isAdmin: false } }[act];
          await api(`/api/admin/users/${user.id}`, { method: "PATCH", json });
        }
        await render();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
}

me = await loadMe();
if (!me) {
  app.innerHTML = `<div class="page narrow"><img src="/crafter-engineering-logo.png" alt="Crafter Engineering" class="brand-logo" /><h1>Administration</h1><div id="login"></div></div>`;
  app.querySelector("#login").append(loginCard({ title: "Sign in", onSuccess: () => location.reload() }));
} else if (me.mustChange) {
  passwordChangeModal();
} else if (!me.isAdmin) {
  app.innerHTML = `${topbarHtml(me)}<div class="page"><h1>Administration</h1><p class="muted">This page is only for site administrators.</p></div>`;
  wireTopbar(app);
} else {
  await render();
}
