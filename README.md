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
- IFC files are converted in the background after upload so they open quickly (status shows on the file).
- Replacing a file overwrites it and increases its version number. There is no history of old versions and deletion is permanent.

## Run it locally

```bash
npm install
npm run dev
```
Open http://localhost:3000. On first run an admin is created: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` first, or read the generated temporary password in the terminal. Requires Node 22.13+ (uses the built-in SQLite).

Production: `npm run build` then `npm start`. See `RENDER-DEPLOY.md` for Render and the settings (`DATA_DIR`, `MAX_UPLOAD_MB`, `PUBLIC_URL`, …).

## How it's built
- `server/index.js` — Express API: sessions, permissions, projects, members, files, IFC conversion queue, audit log.
- `server/security.js` — password hashing (scrypt), sessions (random tokens, only a hash is stored), sign-in throttling, cross-site request protection, security headers (strict content-security-policy in production).
- `server/db.js` — SQLite schema. `server/convert.js` — IFC → compact viewer format + properties.
- `web/` — Vite pages: sign-in/projects (`index`), project (`project`), admin, 3D viewer (`model`), PDF viewer (`pdf`).
- Data layout under `DATA_DIR`: `app.db` (accounts, projects, permissions, file records, audit log) and `files/<id>/` (original file, plus converted model for IFC).

## Security notes
- Every file request is checked on the server against the signed-in user's role for that project; removing someone's access or disabling an account takes effect immediately.
- Uploads are limited to `.pdf`, `.dwg`, `.ifc`, and the file contents must match the type.
- Sessions use HttpOnly, SameSite cookies (Secure over HTTPS). State-changing requests must come from the site itself.
- After 5 failed sign-ins for an account/IP the account is blocked for 15 minutes.
- Use HTTPS (Render provides it), keep `ADMIN_PASSWORD` private, and back up `DATA_DIR`.
