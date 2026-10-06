import {
  api,
  esc,
  loadMe,
  loginCard,
  passwordChangeModal,
  topbarHtml,
  wireTopbar,
  toast,
  ROLE_LABELS,
} from "./common.js";

const app = document.getElementById("app");

function renderLogin() {
  app.innerHTML = `
    <div class="page narrow">
      <img src="/crafter-engineering-logo.png" alt="Crafter Engineering" class="brand-logo" />
      <h1>Project files</h1>
      <p class="muted">Sign in to see the projects you have been given access to. If you opened a project's link or QR code, you'll find it listed here after you sign in.</p>
      <div id="login"></div>
    </div>`;
  app.querySelector("#login").append(loginCard({ title: "Sign in", onSuccess: () => location.reload() }));
}

async function renderDashboard(user) {
  const projects = await api("/api/projects");
  app.innerHTML = `
    ${topbarHtml(user)}
    <div class="page">
      <h1>Your projects</h1>
      ${
        user.isAdmin
          ? `<section class="card">
              <h2>New project</h2>
              <form id="new-project" class="inline-form">
                <label>Name<input name="name" required maxlength="120" placeholder="e.g. 100180 – Shady Lane Car Port" /></label>
                <label>Description (optional)<input name="description" maxlength="500" /></label>
                <button type="submit">Create project</button>
              </form>
              <p class="error" id="new-project-error"></p>
            </section>`
          : ""
      }
      <div class="project-grid">
        ${
          projects.length
            ? projects
                .map(
                  (p) => `
          <a class="card project-card" href="/p/${esc(p.id)}">
            <span class="badge role-${esc(p.role)}">${esc(ROLE_LABELS[p.role] || p.role)}</span>
            <h3>${esc(p.name)}</h3>
            ${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
          </a>`
                )
                .join("")
            : `<p class="muted">${user.isAdmin ? "No projects yet. Create one above." : "You haven't been given access to any projects yet. Ask a project administrator to add you."}</p>`
        }
      </div>
    </div>`;
  wireTopbar(app);

  app.querySelector("#new-project")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const project = await api("/api/projects", { method: "POST", json: { name: form.name.value, description: form.description.value } });
      location.href = `/p/${project.id}`;
    } catch (err) {
      app.querySelector("#new-project-error").textContent = err.message;
      toast(err.message, "error");
    }
  });
}

const user = await loadMe();
if (!user) renderLogin();
else if (user.mustChange) passwordChangeModal();
else await renderDashboard(user);
