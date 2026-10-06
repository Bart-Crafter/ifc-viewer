# Deploying on Render

## Free plan (testing only)
1. Push this repo to GitHub, then in Render: **New → Blueprint**, pick the repo. `render.yaml` sets everything up.
2. When asked, enter `ADMIN_EMAIL` (the email you'll sign in with). Render generates `ADMIN_PASSWORD`; read it in the service's **Environment** tab.
3. Open the site URL, sign in with those details, create a project, then add people from the project page.

**The free plan erases everything** when the service sleeps (about 15 minutes without visitors) or redeploys: accounts, projects, permissions and files. The admin login is recreated from the two settings above, nothing else. Don't put real client files on it.

## Permanent setup (paid plan)
In `render.yaml` change `plan: free` to `plan: starter`, add the `disk:` block shown at the bottom of that file, and add the environment variable `DATA_DIR=/var/data`. The database and all files then live on the disk and survive restarts and redeploys.
Back the disk up regularly (Render disk snapshots, or download the project files through the site). Add a custom domain **before** printing QR codes, so the address never changes.

## Settings (environment variables)
| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Create the first administrator when the database is empty. If `ADMIN_PASSWORD` is omitted a random one is printed in the logs and must be changed at first sign-in. |
| `DATA_DIR` | Where the database and files are stored (default `server/storage`). Point it at the persistent disk. |
| `MAX_UPLOAD_MB` | Largest single upload (default 300). IFC conversion happens in memory, so big models need a bigger instance. |
| `PUBLIC_URL` | Optional. Your site's public address (e.g. `https://projects.example.com`), used inside QR codes. |
| `NODE_VERSION` | Must be 22.13 or newer. |
