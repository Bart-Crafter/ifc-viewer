import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { convertIfc } from "./convert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const storageDir = process.env.STORAGE_DIR
  ? path.join(process.env.STORAGE_DIR, "models")
  : path.join(__dirname, "storage", "models");
const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const uploadToken = process.env.UPLOAD_TOKEN;

await fs.mkdir(storageDir, { recursive: true });

const app = express();
app.set("trust proxy", 1); // so req.protocol reflects the real scheme behind a host's reverse proxy (QR codes must encode https)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const modelDir = (id) => path.join(storageDir, id);
const isValidId = (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);

async function readMeta(id) {
  try {
    const raw = await fs.readFile(path.join(modelDir(id), "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeMeta(id, meta) {
  await fs.writeFile(path.join(modelDir(id), "meta.json"), JSON.stringify(meta, null, 2));
}

async function runConversion(id, buffer) {
  const { fragmentBytes, properties } = await convertIfc(buffer);
  await fs.writeFile(path.join(modelDir(id), "model.frag"), fragmentBytes);
  await fs.writeFile(path.join(modelDir(id), "properties.json"), JSON.stringify(properties));
}

function requireUploadToken(req, res, next) {
  if (!uploadToken) return next(); // no token configured -> auth disabled (local/dev default)
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== uploadToken) return res.status(401).json({ error: "unauthorized" });
  next();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function verifyPassword(password, { salt, hash }) {
  const candidate = crypto.scryptSync(password, Buffer.from(salt, "hex"), 64);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function toPublicMeta(meta) {
  const { password, ...rest } = meta;
  return { ...rest, passwordProtected: !!password };
}

async function requireModelPassword(req, res, next) {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (!meta.password) return next();
  const provided = req.get("x-model-password");
  if (!provided || !verifyPassword(provided, meta.password)) {
    return res.status(401).json({ error: "password required" });
  }
  next();
}

// ---------- API ----------
const api = express.Router();

api.get("/models", async (_req, res) => {
  const ids = await fs.readdir(storageDir).catch(() => []);
  const metas = (await Promise.all(ids.map(readMeta))).filter(Boolean).map(toPublicMeta);
  metas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(metas);
});

api.get("/models/:id", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  res.json(toPublicMeta(meta));
});

api.post("/models", requireUploadToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  const id = nanoid(8);
  const name = (req.body.name || req.file.originalname.replace(/\.ifc$/i, "")).slice(0, 200);
  try {
    await fs.mkdir(modelDir(id), { recursive: true });
    await runConversion(id, req.file.buffer);
    const now = new Date().toISOString();
    const meta = {
      id,
      name,
      revision: 1,
      originalFilename: req.file.originalname,
      createdAt: now,
      updatedAt: now,
      password: req.body.password ? hashPassword(req.body.password) : null,
    };
    await writeMeta(id, meta);
    res.status(201).json(toPublicMeta(meta));
  } catch (err) {
    console.error(err);
    await fs.rm(modelDir(id), { recursive: true, force: true });
    res.status(500).json({ error: "conversion failed", detail: String(err?.message ?? err) });
  }
});

api.post("/models/:id/revise", requireUploadToken, upload.single("file"), async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (!req.file) return res.status(400).json({ error: "file is required" });
  try {
    await runConversion(id, req.file.buffer);
    meta.revision += 1;
    meta.originalFilename = req.file.originalname;
    meta.updatedAt = new Date().toISOString();
    await writeMeta(id, meta);
    res.json(toPublicMeta(meta));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "conversion failed", detail: String(err?.message ?? err) });
  }
});

api.delete("/models/:id", requireUploadToken, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: "not found" });
  await fs.rm(modelDir(id), { recursive: true, force: true });
  res.status(204).end();
});

api.post("/models/:id/password", requireUploadToken, express.json(), async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: "not found" });
  const { password } = req.body ?? {};
  meta.password = password ? hashPassword(password) : null;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(id, meta);
  res.json(toPublicMeta(meta));
});

api.post("/models/:id/verify-password", express.json(), async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (!meta.password) return res.json({ ok: true });
  const { password } = req.body ?? {};
  const ok = typeof password === "string" && verifyPassword(password, meta.password);
  if (!ok) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

api.get("/models/:id/fragments", requireModelPassword, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).end();
  res.sendFile(path.join(modelDir(id), "model.frag"), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

api.get("/models/:id/properties", requireModelPassword, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).end();
  res.sendFile(path.join(modelDir(id), "properties.json"), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

api.get("/models/:id/qr.png", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).end();
  const meta = await readMeta(id);
  if (!meta) return res.status(404).end();
  const url = `${req.protocol}://${req.get("host")}/model/${id}`;
  res.setHeader("Content-Type", "image/png");
  QRCode.toFileStream(res, url, { width: 512, margin: 2 });
});

app.use("/api", api);

// ---------- Frontend (dev: Vite middleware, prod: static build) ----------
const webRoot = path.join(rootDir, "web");

if (isProd) {
  const distDir = path.join(webRoot, "dist");
  app.use(express.static(distDir));
  app.get("/model/:id", (_req, res) => res.sendFile(path.join(distDir, "model.html")));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: webRoot,
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const templatePath = url.startsWith("/model")
        ? path.join(webRoot, "model.html")
        : path.join(webRoot, "index.html");
      let template = await fs.readFile(templatePath, "utf8");
      template = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(template);
    } catch (err) {
      vite.ssrFixStacktrace(err);
      next(err);
    }
  });
}

app.listen(port, () => {
  console.log(`IFC viewer running at http://localhost:${port}`);
});
