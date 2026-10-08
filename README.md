# Crafter Engineering — project file sharing

A secure site for sharing project files with clients, contractors and site workers. Each project is one SharePoint *Submissions* folder. The site shows its files in five folders, and PDFs and IFC models can be viewed in the browser (IFC uses the 3D viewer).

## Folders
Inside each project's Submissions folder the site keeps five sub-folders (it creates them if they are missing):
**01 – PDF · 02 – DWG · 03 – IFC · 04 – CALCS · 05 – OTHER.** 01/02/03 take only PDF/DWG/IFC files; 04 and 05 take any normal file type (programs and scripts such as .exe or .html are refused). Staff can also drop files straight into these folders in SharePoint and they appear on the site.

## Who can do what
| | View PDF / IFC | Download | Upload, replace, rename, delete | Choose who sees which folder; send quick links | Manage people and roles |
|---|---|---|---|---|---|
| **Anyone with the QR / link** (no account) | yes, public folders only | no | no | no | no |
| **Viewer** | yes | no | no | no | no |
| **Client** | yes | yes | no | no | no |
| **Designer** | yes | yes | yes | yes | no |
| **Admin** (project) | yes | yes | yes | yes | yes |

A **site administrator** can do everything on every project, create projects and manage all accounts (`/admin`). One person can hold different roles on different projects.

### The access register (Excel)
Who is on a project, their role, and which folders they can open are kept in **`Project Access.xlsx`**, in the Submissions folder. It is the single source of truth, so it can be edited **on the website** (project page → *Who can see what*) **or by opening the file in SharePoint/OneDrive** (non-technical staff can do this: Yes/No dropdowns, a Role dropdown). Website edits keep any extra columns or notes added by hand; manual edits take effect within about 15 seconds. If the file is deleted or can't be read, nobody except site administrators can open the project (it fails closed); an admin can re-create it from the project page.
- Viewers and clients only see the folders ticked for them. Designers and admins always see everything.
- A person needs an **account** too (admins create them; a temporary password is shown once). A row for someone with no account shows "No account yet" with a *Create account* button.
- Anyone who can edit that Excel file in SharePoint can change who has access, so keep write access to the Submissions folder to staff you trust.

### Project link / QR code (view only, no sign-in)
Designers and admins can show the project's QR code and link. Anyone with it can **view** (never download) the folders marked *public* (by default 01 – PDF and 03 – IFC), straight away, no sign-in, which is meant for workers on site. Treat the QR like a key: a project admin can **Reset link** at any time and the old QR/link stops working immediately.

### Quick-send links ("WeTransfer-style")
Designers and admins can tick files across any folders and create a link that **expires after 3 days** (can be cancelled any time). Anyone with it can download those files (individually or as one zip), as often as they like until it expires. It gives **no access to the project**, other files, or people. The address is shown once when created; only a hash is stored.

### Revision control
Name documents with their revision code at the end: `100478-CFT-DD-XX-DR-C-101 C02.pdf` is drawing `100478-CFT-DD-XX-DR-C-101`, revision **C02** (a space, `_` or `-` before the code works too). The letter is the stage, ranked **P** (preliminary) < **B** (for approval) < **C** (construction), then by number, so C01 supersedes B09. Change the order with the `REVISION_ORDER` setting (default `PBC`; other letters rank after those).
- Revisions of the same drawing (same name, same file type, in any folder) are grouped. The project page marks each file with its revision and **Latest** or **Superseded by …**, and viewers and clients can hide superseded ones.
- Opening a superseded drawing in the PDF or 3D viewer shows a red **Out of date** banner with a button to open the latest. Uploading an older revision than the latest warns the uploader.
- **QR code on a drawing:** designers click **QR** on a PDF or IFC to get a code to print on that drawing. It carries the drawing and the revision it was printed from. Whoever scans it is taken to the *newest* revision and told "that QR code was for revision C01, which has been replaced". If the newest revision is in a folder they can't open, they are told a newer one exists and to ask for it. Scanning needs no sign-in if the folder is public.
- Files without a revision code behave as before.

### Copyright and sharing rights
Uploading asks the person to confirm Crafter Engineering has the right to share the file, and the server records it. Pages carry a confidentiality/copyright notice. See [docs/COPYRIGHT-AND-LIABILITY.md](docs/COPYRIGHT-AND-LIABILITY.md) for the risks of hosting files that reference other companies' drawings or licensed data, and the recommended policy.

### Other notes
- Accounts are created by an admin. A temporary password is shown once; the person must choose their own at first sign-in.
- **View-only is "view only" in the site, not tamper-proof.** There are no download buttons, the download links refuse it, PDFs are drawn by the page itself (no browser save/print button) and can't be opened by direct address. A determined technical person can still capture what their browser displays (screenshots, developer tools). For confidential material give Client access only to people you trust with the file, and keep sensitive folders off the public list.
- **Files live in SharePoint.** Replacing a file keeps SharePoint's version history; deleting sends it to the SharePoint recycle bin. Removing a project from the site never touches the files.
- IFC files are converted in the background the first time they are seen, and the converted copy is cached in a `_viewer-cache` subfolder next to the model (status shows on the file).

## Run it locally

```bash
npm install
npm run dev
```
Open http://localhost:3000. On first run an admin is created: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` first, or read the generated temporary password in the terminal. Requires Node 22.13+. Without `DATABASE_URL` it uses a throwaway embedded Postgres, and without the `AZURE_*` settings it keeps each project's files in a local folder, so you can try everything offline.

Production: `npm run build` then `npm start`. See `RENDER-DEPLOY.md` for Render and all settings, and `docs/IT-SETUP-SHAREPOINT.md` for the Microsoft 365 side (hand that page to IT).

## How it's built
- `server/index.js` — Express API: sessions, per-folder permissions, projects, project link, quick-send links, files, IFC conversion queue, audit log. `server/register.js` — reads/writes the `Project Access.xlsx` register.
- `server/security.js` — password hashing (scrypt), sessions (random tokens, only a hash is stored), sign-in throttling, cross-site request protection, security headers (strict content-security-policy in production).
- `server/db.js` — PostgreSQL schema (hosted, or embedded PGlite for development). `server/convert.js` — IFC → compact viewer format + properties.
- `server/storage-backends/` — where files live: `graph.js` (SharePoint via Microsoft Graph) or `local.js` (development folder). `scripts/Grant-ProjectFolder.ps1` — IT script that grants the app one folder.
- `web/` — Vite pages: sign-in/projects (`index`), project (`project`), admin, 3D viewer (`model`), PDF viewer (`pdf`), quick-link download page (`share`).
- Data: accounts, the audit log and quick-link records are in Postgres; files **and the access register** are in SharePoint. The app can only see folders IT has explicitly granted it (Microsoft *Selected* permissions), and every request is checked against the person's role and folder access first.

## Security notes
- Every file request is checked on the server against the person's role and folder access; changes made on the site apply at once, and manual Excel edits within about 15 seconds. Disabling an account takes effect immediately.
- PDF/DWG/IFC uploads must match their type (checked by contents); 04/05 refuse executable and script types. Everything is served as a download or through the page's own viewer, never as a web page.
- The project link and quick-link tokens are long random values; quick links are stored as hashes, expire after 3 days and can be cancelled. Repeated bad guesses are blocked.
- Sessions use HttpOnly, SameSite cookies (Secure over HTTPS). State-changing requests must come from the site itself.
- After 5 failed sign-ins for an account/IP the account is blocked for 15 minutes.
- Use HTTPS (Render provides it), keep `ADMIN_PASSWORD`, `DATABASE_URL` and the Microsoft client secret private. Back-up of files is SharePoint's job; the database holds only accounts, permissions and logs.
