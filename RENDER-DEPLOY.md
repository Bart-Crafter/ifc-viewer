# Deploying on Render (free plan, no disk)

The website runs on Render. It stores **nothing itself**:

| What | Where |
|---|---|
| Accounts, project permissions, activity log | Free hosted Postgres database (Neon) |
| Project files (PDF / DWG / IFC) and converted IFC models | Your SharePoint, in each project's *Submissions* folder |

So there is no Render disk to pay for, and the site can sleep or redeploy without losing anything.

## 1. Database (5 minutes)
1. Sign up at <https://neon.tech> (free), create a project (pick a region near Render's, e.g. Frankfurt or London).
2. On the project dashboard copy the **connection string** (starts with `postgresql://`). Keep it private; it is a password.

## 2. Microsoft side (your IT provider)
Give them `docs/IT-SETUP-SHAREPOINT.md`. They return a tenant ID, client ID and client secret, and a *project code* for each Submissions folder.
Until that is done you can still try the site: leave the three `AZURE_*` settings empty and it stores files in a temporary local folder instead (testing only, lost on every restart).

## 3. Render
1. Push this repo to GitHub, then in Render: **New → Blueprint**, pick the repo. `render.yaml` sets everything up.
2. When asked, fill in: `DATABASE_URL`, `ADMIN_EMAIL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (and optionally `PUBLIC_URL`). Render generates `ADMIN_PASSWORD`; read it in the service's **Environment** tab.
3. Open the site, sign in with the admin email and that password, then **New project**: paste the *project code* from IT (or the folder's SharePoint address), and add people from the project page.

The first admin is only created when the database is empty. To change the admin later use the Admin page, not the environment variables.
Add a custom domain **before** printing QR codes so the address never changes.

## Settings (environment variables)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Without it a throwaway local database is used (development only). |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | The Microsoft app that reaches SharePoint. Without them files go to a local folder (development only). |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Create the first administrator when the database is empty. If `ADMIN_PASSWORD` is omitted a random one is printed in the logs and must be changed at first sign-in. |
| `MAX_UPLOAD_MB` | Largest single upload (default 300). IFC conversion happens in memory, so big models need a bigger instance. |
| `PUBLIC_URL` | Optional. Your site's public address (e.g. `https://projects.example.com`), used inside QR codes. |
| `DATA_DIR` | Scratch folder for uploads in transit (and the local test database/files). Default `server/storage`. |
| `NODE_VERSION` | Must be 22.13 or newer. |
