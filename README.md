# IFC Viewer

Upload an IFC file, get back a stable model URL + QR code. Re-upload a revision
later and the same URL/QR keeps working — it now shows the new version.

Built on [That Open](https://github.com/ThatOpen) (`web-ifc` + `@thatopen/fragments`
+ `@thatopen/components`): IFC is converted server-side into the compact binary
Fragments format plus a JSON property lookup, so the browser viewer never has to
parse raw IFC and clicking an element for its properties (fire rating, asset code,
etc.) stays fast on a phone.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000, upload an `.ifc` file, then open the model link.

## Production

```bash
npm run build
npm start
```

`npm start` serves the built frontend and runs on `PORT` (default 3000).

### Environment variables

| Variable       | Default                     | Purpose |
|----------------|------------------------------|---------|
| `PORT`         | `3000`                       | Port the server listens on. |
| `STORAGE_DIR`  | `server/storage`              | Parent directory for converted models (actual files live in `<STORAGE_DIR>/models/<id>/`). Point this at a persistent volume/disk in production — the app stores real files here, not a database. |
| `UPLOAD_TOKEN` | *(unset = no auth)*           | If set, publishing (`POST /api/models`) and revising (`POST /api/models/:id/revise`) require `Authorization: Bearer <token>`. Viewing/QR stay public either way. Set this before deploying anywhere public. |

## Deploying (Railway)

This app needs a real, always-on process (not a static host) plus a persistent
disk for `server/storage`, since converted models are stored as files, not in
a database. [Railway](https://railway.app) fits both requirements with a free
subdomain + HTTPS out of the box, so it's a reasonable default if you don't
already have hosting:

1. Create a Railway account and install the CLI: `npm i -g @railway/cli`, then
   `railway login` (opens your browser — this is your account, not something
   I can do on your behalf).
2. From this project folder: `railway init` to create a project, then
   `railway up` to deploy the current code directly (no GitHub repo needed).
3. In the Railway dashboard for this service: **Add a Volume**, mount it at
   e.g. `/data`.
4. Set two environment variables on the service: `STORAGE_DIR=/data` and
   `UPLOAD_TOKEN=<a-long-random-secret-you-choose>`.
5. Railway auto-detects the Node app, runs `npm install` then `npm start`
   (which itself runs the production build's server), and gives you a public
   `https://<something>.up.railway.app` URL with HTTPS already handled.
6. Open that URL, upload your first model, and its QR code will encode that
   same public URL — printable and stable across future revisions.

To publish or revise a model from the site once `UPLOAD_TOKEN` is set, the
upload form will prompt you once for the token and remember it in the
browser after that.

Note the QR code bakes in whatever domain you were on when it was generated —
if you add a custom domain later (Railway → Settings → Domains) and re-generate
QR codes after that, they'll point at the new domain instead. Railway's own
`*.up.railway.app` URL generally keeps working alongside a custom domain, so
QR codes generated before the switch should still resolve, but confirm that in
Railway's dashboard for your service before relying on it for anything printed.

## How it works

- `server/convert.js` — runs the IFC → Fragments conversion (`IfcImporter`) and
  extracts property sets for every element with geometry into a flat JSON map
  keyed by element ID.
- `server/index.js` — Express API: upload (`POST /api/models`), revise in place
  (`POST /api/models/:id/revise`), list/read, serve the fragments/properties
  files, and generate a QR PNG pointing at `/model/:id`.
- `web/` — Vite frontend: `index.html` is the upload/browse page, `model.html`
  is the 3D viewer (Three.js via `@thatopen/components`) with click-to-inspect
  properties, orange highlight on the selected element, and a length
  measurement tool (`@thatopen/components-front`'s `LengthMeasurement`).
- `server/storage/models/<id>/` holds `model.frag`, `properties.json`, and
  `meta.json` per model. Re-uploading a revision overwrites these in place and
  bumps `meta.json`'s revision counter — the model ID (and therefore every
  printed QR code) never changes.
- Deleting a model (`DELETE /api/models/:id`, token-protected) removes its
  storage directory entirely — its QR code stops working immediately.

### Per-model passwords

Any model can optionally require a password to *view* (separate from
`UPLOAD_TOKEN`, which gates publishing/revising). Set one at upload time, or
add/change/remove one later via the "Add/Change password" button on the home
page. The password is stored as a salted hash (`crypto.scryptSync`, never
plaintext) in that model's `meta.json`. A visitor opening a protected model's
link sees a lock screen; the correct password is remembered in their browser
after that, same as the upload token. The home page always lists every model's
name (with a 🔒 if protected) — only the actual geometry/property data behind
`/api/models/:id/fragments` and `/properties` is gated.

## Notes / next steps

- The Fragments worker is self-hosted via Vite (`@thatopen/fragments/worker`),
  so viewing doesn't depend on a CDN.
- Auth is a single shared `UPLOAD_TOKEN` for publishing, plus optional
  per-model view passwords — no per-user accounts. Fine for one team
  publishing models, not for multi-tenant use.
- Large IFC files: `multer` is configured for up to 2 GB uploads and holds the
  file in memory during conversion; for very large/frequent uploads, consider
  streaming to disk instead.
- The measurement tool creates a point on the first double-click on geometry
  and completes the measurement on the second; press Delete/Backspace to
  remove the one your cursor is over, or use "Clear" to remove all of them.
  Measurements are session-only (not saved), and edge-snapping mode is the
  default.
- Not yet implemented: coordination between multiple linked models
  (federation), area/volume measurement (the same package also exposes
  `AreaMeasurement`/`VolumeMeasurement` if useful later).
