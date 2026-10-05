# Deploying IFC Viewer on Render

A Node/Express app (with a built Vite frontend) that converts IFC files and serves them with a 3D viewer and QR codes.

## Requirements
- A Render account **on a paid plan** for the web service. Models are stored as files on a persistent disk, and Render only offers disks on paid services. (A free service sleeps after 15 minutes and wipes its filesystem, so it won't work.)
- A Git repository (GitHub/GitLab/Bitbucket) containing this code. Render deploys from Git.

## Steps
1. Unzip, create a new Git repo, commit everything and push it.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml` and creates:
   - one web service (`ifc-viewer`, plan `starter`)
   - a 2 GB persistent disk mounted at `/var/data`
   - env vars: `NODE_VERSION=22`, `STORAGE_DIR=/var/data`, and an auto-generated `UPLOAD_TOKEN`
3. Click **Apply**. The first build takes a few minutes.
4. Open the service → **Environment** and copy the `UPLOAD_TOKEN` value. The site asks for it the first time you publish, revise, delete or set a password on a model.
5. Open the `https://<name>.onrender.com` URL and upload an IFC file.

Manual setup instead of a Blueprint: create a Node web service with build command
`npm install --include=dev && npm run build`, start command `npm start`, health check path `/api/models`,
a disk mounted at `/var/data`, and the three env vars above.

## Things to know
- **QR codes encode the site's domain.** Add a custom domain on Render *before* generating codes you intend to print, so the address never changes if you move hosts.
- Uploaded IFC originals are not kept. Only converted models are stored on the disk, so keep your source files. Back up the disk if the models matter.
- Anyone with a model's link can view it unless you set a per-model password. Only people with `UPLOAD_TOKEN` can publish, revise, delete or change passwords.
- Large IFC files are held in memory while converting. If conversion fails on big models, move to a larger instance size.
- Local run: `npm install`, then `npm run dev` (http://localhost:3000). See `README.md` for details.
