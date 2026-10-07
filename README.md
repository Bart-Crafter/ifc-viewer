# Crafter Engineering — project file sharing

A secure site for sharing project files with clients. Each project has a link / QR code that anyone can open, but it only shows a sign-in page: **nobody sees any files unless they are signed in and have been given access.** Inside a project there are three folders — **PDF**, **DWG** and **IFC**. PDFs and IFC models can be viewed in the browser (IFC uses the 3D viewer); every file type can be downloaded by people allowed to.

## Roles (set per project)

| Role | View PDF / IFC | Download | Upload, replace, rename, delete | Manage who has access |
|---|---|---|---|---|
| **Viewer** | yes | no | no | no |
| **Client** | yes | yes | no | no |
| **Designer** | yes | yes | yes | no |
| **Admin** (project) | yes | yes | yes | yes |

A **site administrator** can do everything on every project, create projects and manage all accounts (`/admin`). One person can hold different roles on different projects.

- Accounts are created by an admin (site admins on `/admin`, project admins when they add someone by email). A temporary password is shown once; the person must choose their own at first sign-in.
- **Viewer is "view only" in the site, not tamper-proof.** There are no download buttons, the download links refuse Viewers, PDFs are drawn by the page itself (no browser save/print button) and can't be opened by direct address. A determined technical person can still capture what their browser displays (screenshots, developer tools). For genuinely confidential material, give people Client access only if you trust them with the file.
- **Files live in SharePoint.** Each project is one SharePoint folder (the project's *4 – Submissions* folder). Files staff add or change there appear on the site automatically. Replacing a file keeps SharePoint's version history; deleting sends it to the SharePoint recycle bin. Removing a project from the site never touches the files.
- IFC files are converted in the background the first time they are seen, and the converted copy is cached in a `_viewer-cache` subfolder (status shows on the file).

## Run it locally

```bash
npm install
npm run dev
```
Open http://localhost:3000. On first run an admin is created: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` first, or read the generated temporary password in the terminal. Requires Node 22.13+. Without `DATABASE_URL` it uses a throwaway embedded Postgres, and without the `AZURE_*` settings it keeps each project's files in a local folder, so you can try everything offline.

Production: `npm run build` then `npm start`. See `RENDER-DEPLOY.md` for Render and all settings, and `docs/IT-SETUP-SHAREPOINT.md` for the Microsoft 365 side (hand that page to IT).

## How it's built
- `server/index.js` — Express API: sessions, permissions, projects, members, files, IFC conversion queue, audit log.
- `server/security.js` — password hashing (scrypt), sessions (random tokens, only a hash is stored), sign-in throttling, cross-site request protection, security headers (strict content-security-policy in production).
- `server/db.js` — PostgreSQL schema (hosted, or embedded PGlite for development). `server/convert.js` — IFC → compact viewer format + properties.
- `server/storage-backends/` — where files live: `graph.js` (SharePoint via Microsoft Graph) or `local.js` (development folder). `scripts/Grant-ProjectFolder.ps1` — IT script that grants the app one folder.
- `web/` — Vite pages: sign-in/projects (`index`), project (`project`), admin, 3D viewer (`model`), PDF viewer (`pdf`).
- Data: accounts, permissions and the audit log are in Postgres; files are in SharePoint. The app can only see folders IT has explicitly granted it (Microsoft *Selected* permissions), and every request is checked against the signed-in user's role first.

## Security notes
- Every file request is checked on the server against the signed-in user's role for that project; removing someone's access or disabling an account takes effect immediately.
- Uploads are limited to `.pdf`, `.dwg`, `.ifc`, and the file contents must match the type.
- Sessions use HttpOnly, SameSite cookies (Secure over HTTPS). State-changing requests must come from the site itself.
- After 5 failed sign-ins for an account/IP the account is blocked for 15 minutes.
- Use HTTPS (Render provides it), keep `ADMIN_PASSWORD`, `DATABASE_URL` and the Microsoft client secret private. Back-up of files is SharePoint's job; the database holds only accounts, permissions and logs.
