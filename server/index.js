import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { openDb } from "./db.js";
import { createBackend } from "./storage-backends/index.js";
import { StorageError } from "./storage-backends/errors.js";
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
  passwordProblem,
  generateTempPassword,
  createSessions,
  readCookie,
  createFailureLimiter,
  csrfGuard,
  securityHeaders,
} from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const dataDir = process.env.DATA_DIR || process.env.STORAGE_DIR || path.join(__dirname, "storage");
const tmpDir = path.join(dataDir, "tmp");
const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 300;
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");

fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

process.on("unhandledRejection", (err) => console.error("Unhandled error:", err));
console.log("Starting...");
const db = await openDb({ dataDir, url: process.env.DATABASE_URL });
const sessions = createSessions(db);
const storage = createBackend({ dataDir, env: process.env });
console.log(`File storage: ${storage.kind === "sharepoint" ? "SharePoint (Microsoft Graph)" : "local folder (development only)"}`);

const now = () => new Date().toISOString();
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin, mustChange: !!u.must_change });

async function audit(req, action, { projectId = null, fileId = null, detail = null } = {}) {
  try {
    await db.run("INSERT INTO audit (ts, user_id, action, project_id, file_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      now(),
      req.user?.id ?? null,
      action,
      projectId,
      fileId,
      detail,
      req.ip ?? null,
    ]);
  } catch (err) {
    console.error("Could not write audit entry:", err.message);
  }
}

const userById = (id) => db.one("SELECT * FROM users WHERE id = $1", [id]);
const userByEmail = (email) => db.one("SELECT * FROM users WHERE email = $1", [email]);
const projectById = (id) => db.one("SELECT * FROM projects WHERE id = $1", [id]);
const insertUser = (d, { id, email, name, salt, hash, isAdmin, mustChange }) =>
  d.run("INSERT INTO users (id, email, name, pw_salt, pw_hash, is_admin, must_change, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    id,
    email,
    name,
    salt,
    hash,
    isAdmin ? 1 : 0,
    mustChange ? 1 : 0,
    now(),
  ]);
const upsertMember = (projectId, userId, role, grantedBy) =>
  db.run(
    `INSERT INTO memberships (project_id, user_id, role, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by`,
    [projectId, userId, role, grantedBy, now()]
  );

// ---------- roles ----------
// viewer: view PDFs/IFC only. client: + download. designer: + upload/replace/rename/delete. admin: + manage members.
const RANK = { viewer: 1, client: 2, designer: 3, admin: 4 };
const ROLES = Object.keys(RANK);

async function roleFor(user, projectId) {
  if (!user) return null;
  if (user.is_admin) return "admin";
  return (await db.one("SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2", [projectId, user.id]))?.role ?? null;
}

const can = (role, min) => !!role && RANK[role] >= RANK[min];

// ---------- first-run admin ----------
async function bootstrapAdmin() {
  if (await db.one("SELECT 1 AS x FROM users LIMIT 1")) return;
  const email = (process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
  const fromEnv = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || generateTempPassword();
  const { salt, hash } = await hashPassword(password);
  await insertUser(db, { id: nanoid(12), email, name: "Administrator", salt, hash, isAdmin: true, mustChange: !fromEnv });
  console.log(`First-run admin created: ${email}`);
  if (!fromEnv) console.log(`Temporary password (change it at first login): ${password}`);
}
await bootstrapAdmin();

// ---------- app + guards ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Health check for the host: answers without touching the database or sessions.
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// Log the first requests, so a deploy that "starts" but never answers is visible in the host's log.
let logged = 0;
app.use((req, res, next) => {
  if (logged < 25) {
    logged++;
    const t = Date.now();
    res.on("finish", () => console.log(`Request ${req.method} ${req.originalUrl.split("?")[0]} -> ${res.statusCode} (${Date.now() - t} ms)`));
  }
  next();
});
app.use(securityHeaders(isProd));
app.use(express.json({ limit: "100kb" }));

const api = express.Router();
app.use("/api", api);

api.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

api.use(async (req, res, next) => {
  req.sessionToken = readCookie(req, "sid");
  req.user = await sessions.lookup(req.sessionToken);
  if (req.user?.must_change && !req.path.startsWith("/auth/")) {
    return res.status(403).json({ error: "password_change_required" });
  }
  next();
});
api.use(csrfGuard);

const requireLogin = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Please sign in." });
const requireSiteAdmin = (req, res, next) =>
  req.user?.is_admin ? next() : res.status(req.user ? 403 : 401).json({ error: "Administrator access required." });

async function projectCtx(req, res, next) {
  const project = await projectById(req.params.pid);
  if (!project) return res.status(404).json({ error: "Project not found." });
  req.project = project;
  req.role = await roleFor(req.user, project.id);
  next();
}

// File ids are "<projectId>~<storage item id>". The storage item is only looked up after the role check,
// and the backend confirms it really sits in this project's folder.
async function fileCtx(req, res, next) {
  const [pid, ...rest] = String(req.params.fid).split("~");
  const itemId = rest.join("~");
  const project = pid && itemId ? await projectById(pid) : null;
  if (!project) return res.status(404).json({ error: "File not found." });
  req.project = project;
  req.itemId = itemId;
  req.role = await roleFor(req.user, project.id);
  next();
}

async function loadFile(req, res, next) {
  const entry = await storage.get(req.project, req.itemId);
  if (!entry || !FOLDERS.includes(extOf(entry.name))) return res.status(404).json({ error: "File not found." });
  req.entry = entry;
  next();
}

const needRole = (min) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (!can(req.role, min)) return res.status(403).json({ error: "You don't have permission to do that." });
  next();
};

const cleanText = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;

// ---------- auth ----------
const userFailures = createFailureLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const ipFailures = createFailureLimiter({ max: 30, windowMs: 15 * 60 * 1000 });

api.post("/auth/login", async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });

  const userKey = `${email}|${req.ip}`;
  const ipKey = req.ip;
  const wait = Math.max(userFailures.blockedFor(userKey), ipFailures.blockedFor(ipKey));
  if (wait) {
    return res
      .status(429)
      .set("Retry-After", String(wait))
      .json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  }

  const user = await userByEmail(email);
  let ok = false;
  if (user && !user.disabled) ok = await verifyPassword(password, { salt: user.pw_salt, hash: user.pw_hash });
  else await fakeVerify(password);

  if (!ok) {
    userFailures.fail(userKey);
    ipFailures.fail(ipKey);
    await audit(req, "login_failed", { detail: email });
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  userFailures.clear(userKey);
  const token = await sessions.create(user.id);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: sessions.maxAgeMs });
  req.user = user;
  await audit(req, "login");
  res.json({ user: publicUser(user) });
});

api.post("/auth/logout", async (req, res) => {
  await sessions.destroy(req.sessionToken);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

api.get("/auth/me", (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

api.post("/auth/change-password", requireLogin, async (req, res) => {
  const current = typeof req.body?.current === "string" ? req.body.current : "";
  const next = req.body?.next;
  const user = await userById(req.user.id);
  if (!(await verifyPassword(current, { salt: user.pw_salt, hash: user.pw_hash }))) {
    return res.status(400).json({ error: "Your current password is incorrect." });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (next === current) return res.status(400).json({ error: "Choose a different password." });
  const { salt, hash } = await hashPassword(next);
  await db.run("UPDATE users SET pw_salt = $1, pw_hash = $2, must_change = 0 WHERE id = $3", [salt, hash, user.id]);
  await sessions.destroyOthers(user.id, req.sessionToken);
  await audit(req, "password_changed");
  res.json({ ok: true });
});

// ---------- admin: users ----------
const adminUserRow = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isAdmin: !!u.is_admin,
  disabled: !!u.disabled,
  mustChange: !!u.must_change,
  createdAt: u.created_at,
  projects: u.projects ?? 0,
});

api.get("/admin/users", requireSiteAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT u.*, (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id)::int AS projects
       FROM users u ORDER BY lower(u.name)`
  );
  res.json(rows.map(adminUserRow));
});

api.post("/admin/users", requireSiteAdmin, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const name = cleanText(req.body?.name, 120) || email.split("@")[0];
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (await userByEmail(email)) return res.status(409).json({ error: "An account with that email already exists." });
  const tempPassword = generateTempPassword();
  const { salt, hash } = await hashPassword(tempPassword);
  const id = nanoid(12);
  await insertUser(db, { id, email, name, salt, hash, isAdmin: !!req.body?.isAdmin, mustChange: true });
  await audit(req, "user_created", { detail: email });
  res.status(201).json({ user: adminUserRow(await userById(id)), tempPassword });
});

api.patch("/admin/users/:uid", requireSiteAdmin, async (req, res) => {
  const user = await userById(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found." });
  const isSelf = user.id === req.user.id;
  const { name, isAdmin, disabled, resetPassword } = req.body ?? {};
  if (isSelf && (isAdmin === false || disabled === true)) {
    return res.status(400).json({ error: "You can't remove your own admin access or disable your own account." });
  }
  if (typeof name === "string" && cleanText(name, 120)) {
    await db.run("UPDATE users SET name = $1 WHERE id = $2", [cleanText(name, 120), user.id]);
  }
  if (typeof isAdmin === "boolean") await db.run("UPDATE users SET is_admin = $1 WHERE id = $2", [isAdmin ? 1 : 0, user.id]);
  if (typeof disabled === "boolean") {
    await db.run("UPDATE users SET disabled = $1 WHERE id = $2", [disabled ? 1 : 0, user.id]);
    if (disabled) await sessions.destroyAllForUser(user.id);
  }
  let tempPassword;
  if (resetPassword) {
    tempPassword = generateTempPassword();
    const { salt, hash } = await hashPassword(tempPassword);
    await db.run("UPDATE users SET pw_salt = $1, pw_hash = $2, must_change = 1 WHERE id = $3", [salt, hash, user.id]);
    await sessions.destroyAllForUser(user.id);
  }
  await audit(req, "user_updated", { detail: `${user.email}${resetPassword ? " (password reset)" : ""}` });
  res.json({ user: adminUserRow(await userById(user.id)), tempPassword });
});

api.delete("/admin/users/:uid", requireSiteAdmin, async (req, res) => {
  const user = await userById(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  await db.run("DELETE FROM users WHERE id = $1", [user.id]);
  await audit(req, "user_deleted", { detail: user.email });
  res.status(204).end();
});

// ---------- projects ----------
api.get("/storage", requireSiteAdmin, (req, res) => res.json({ kind: storage.kind }));

api.get("/projects", requireLogin, async (req, res) => {
  const rows = req.user.is_admin
    ? (await db.all("SELECT * FROM projects ORDER BY lower(name)")).map((p) => ({ ...p, role: "admin" }))
    : await db.all(
        `SELECT p.*, m.role FROM projects p JOIN memberships m ON m.project_id = p.id
          WHERE m.user_id = $1 ORDER BY lower(p.name)`,
        [req.user.id]
      );
  res.json(rows.map((p) => ({ id: p.id, name: p.name, description: p.description, role: p.role })));
});

// A project is one SharePoint folder (the project's "Submissions" folder). Site admins link it by pasting the
// folder's SharePoint address, or by giving its drive and item ids.
api.post("/projects", requireSiteAdmin, async (req, res) => {
  let name = cleanText(req.body?.name, 120);
  let driveId = null;
  let itemId = null;
  if (storage.kind === "sharepoint") {
    // One box takes either the folder's address or the "driveId|itemId" code printed by the IT grant script.
    const pasted = cleanText(req.body?.sharepointUrl, 2000);
    const code = !/^https?:\/\//i.test(pasted) && pasted.includes("|") ? pasted.split("|").map((x) => x.trim()) : null;
    const url = code ? "" : pasted;
    const ids = code ? { driveId: code[0], itemId: code[1] } : { driveId: cleanText(req.body?.driveId, 300), itemId: cleanText(req.body?.itemId, 300) };
    if (!url && !(ids.driveId && ids.itemId)) return res.status(400).json({ error: "Paste the SharePoint address of the project's Submissions folder." });
    let folder;
    try {
      folder = await storage.describeFolder(url ? { url } : ids);
    } catch (err) {
      if (err.code === "missing" || err.code === "unavailable") {
        return res.status(400).json({
          error:
            "Couldn't open that SharePoint folder. Check the address, and that the folder has been shared with this site's Microsoft app (ask IT to run the grant script for it).",
        });
      }
      throw err;
    }
    driveId = folder.driveId;
    itemId = folder.itemId;
    if (await db.one("SELECT 1 AS x FROM projects WHERE drive_id = $1 AND item_id = $2", [driveId, itemId])) {
      return res.status(409).json({ error: "That SharePoint folder is already set up as a project." });
    }
    name ||= folder.name;
  }
  if (!name) return res.status(400).json({ error: "Enter a project name." });
  const id = nanoid(10);
  await db.run("INSERT INTO projects (id, name, description, drive_id, item_id, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    id,
    name,
    cleanText(req.body?.description, 500),
    driveId,
    itemId,
    now(),
    req.user.id,
  ]);
  await audit(req, "project_created", { projectId: id, detail: name });
  res.status(201).json({ id, name });
});

// What anyone with the link can see: just the project name.
api.get("/projects/:pid", projectCtx, (req, res) => {
  const { id, name, description } = req.project;
  res.json({ id, name, description, role: req.role, signedIn: !!req.user });
});

api.patch("/projects/:pid", projectCtx, needRole("admin"), async (req, res) => {
  const name = cleanText(req.body?.name, 120) || req.project.name;
  const description = typeof req.body?.description === "string" ? cleanText(req.body.description, 500) : req.project.description;
  await db.run("UPDATE projects SET name = $1, description = $2 WHERE id = $3", [name, description, req.project.id]);
  await audit(req, "project_updated", { projectId: req.project.id });
  res.json({ id: req.project.id, name, description });
});

// Removing a project from the site never touches the files: they stay in SharePoint.
api.delete("/projects/:pid", projectCtx, requireSiteAdmin, async (req, res) => {
  await db.run("DELETE FROM projects WHERE id = $1", [req.project.id]);
  listings.delete(req.project.id);
  await audit(req, "project_deleted", { detail: req.project.name });
  res.status(204).end();
});

api.get("/projects/:pid/qr.png", projectCtx, (req, res) => {
  const base = publicUrl || `${req.protocol}://${req.get("host")}`;
  res.type("png");
  QRCode.toFileStream(res, `${base}/p/${req.project.id}`, { width: 512, margin: 2 });
});

// ---------- project members ----------
api.get("/projects/:pid/members", projectCtx, needRole("admin"), async (req, res) => {
  res.json(
    await db.all(
      `SELECT u.id, u.email, u.name, u.disabled, m.role, m.granted_at FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY lower(u.name)`,
      [req.project.id]
    )
  );
});

api.post("/projects/:pid/members", projectCtx, needRole("admin"), async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const role = req.body?.role;
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });

  let user = await userByEmail(email);
  let tempPassword;
  if (!user) {
    tempPassword = generateTempPassword();
    const { salt, hash } = await hashPassword(tempPassword);
    const id = nanoid(12);
    await insertUser(db, { id, email, name: cleanText(req.body?.name, 120) || email.split("@")[0], salt, hash, isAdmin: false, mustChange: true });
    user = await userById(id);
    await audit(req, "user_created", { projectId: req.project.id, detail: email });
  }
  await upsertMember(req.project.id, user.id, role, req.user.id);
  await audit(req, "access_granted", { projectId: req.project.id, detail: `${email} as ${role}` });
  res.status(201).json({ member: { id: user.id, email: user.email, name: user.name, role }, tempPassword });
});

api.patch("/projects/:pid/members/:uid", projectCtx, needRole("admin"), async (req, res) => {
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });
  const user = await userById(req.params.uid);
  const member = user && (await db.one("SELECT 1 AS x FROM memberships WHERE project_id = $1 AND user_id = $2", [req.project.id, user.id]));
  if (!member) return res.status(404).json({ error: "Member not found." });
  await upsertMember(req.project.id, user.id, role, req.user.id);
  await audit(req, "role_changed", { projectId: req.project.id, detail: `${user.email} to ${role}` });
  res.json({ ok: true });
});

api.delete("/projects/:pid/members/:uid", projectCtx, needRole("admin"), async (req, res) => {
  const user = await userById(req.params.uid);
  if (!user) return res.status(404).json({ error: "Member not found." });
  await db.run("DELETE FROM memberships WHERE project_id = $1 AND user_id = $2", [req.project.id, user.id]);
  await audit(req, "access_removed", { projectId: req.project.id, detail: user.email });
  res.status(204).end();
});

api.get("/projects/:pid/activity", projectCtx, needRole("admin"), async (req, res) => {
  res.json(
    await db.all(
      `SELECT a.ts, a.action, a.detail, a.file_id, u.name AS user_name, u.email AS user_email
         FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 100`,
      [req.project.id]
    )
  );
});

// ---------- files (stored in SharePoint; this server only brokers access) ----------
const FOLDERS = ["pdf", "dwg", "ifc"];
const extOf = (name) => path.extname(name).slice(1).toLowerCase();
const fileKey = (project, entry) => `${project.id}~${entry.id}`;
const versionTag = (entry) => crypto.createHash("sha1").update(entry.versionKey).digest("hex").slice(0, 12);
const cacheNames = (entry) => ({ frag: `${entry.id}_${versionTag(entry)}.frag`, props: `${entry.id}_${versionTag(entry)}.json` });

const upload = multer({
  storage: multer.diskStorage({ destination: tmpDir, filename: (req, file, cb) => cb(null, nanoid(16)) }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

function uploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That file is larger than ${MAX_UPLOAD_MB} MB.` : "Upload failed." });
  });
}

// SharePoint disallows these characters, and names may not end in a dot or space.
const sanitizeName = (name) =>
  path
    .basename(String(name).replace(/\\/g, "/"))
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .trim()
    .slice(0, 200)
    .replace(/[. ]+$/, "");

// multer reports file names as latin1; recover the real UTF-8 name.
const uploadedName = (file) => sanitizeName(Buffer.from(file.originalname, "latin1").toString("utf8"));

async function looksLikeType(filePath, ext) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead).toString("latin1");
    if (ext === "pdf") return head.includes("%PDF-");
    if (ext === "ifc") return /^\s*ISO-10303-21/.test(head);
    if (ext === "dwg") return /^AC10\d\d/.test(head);
    return false;
  } finally {
    await handle.close();
  }
}

// Short-lived cache of a project's file list (plus which IFC models are already converted) so the page and its
// polling don't hammer SharePoint. Dropped whenever this server changes something.
const listings = new Map();
const LISTING_TTL_MS = 8000;

async function listing(project) {
  const hit = listings.get(project.id);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit;
  const [entries, cached, failures] = await Promise.all([
    storage.list(project),
    storage.cacheList(project),
    db.all("SELECT item_id, version_key, error FROM conversion_failures WHERE project_id = $1", [project.id]),
  ]);
  const failed = new Map(failures.map((f) => [f.item_id, f]));
  const files = entries
    .filter((e) => FOLDERS.includes(extOf(e.name)))
    .map((e) => {
      const folder = extOf(e.name);
      let status = "ready";
      let error = null;
      if (folder === "ifc") {
        const names = cacheNames(e);
        const failure = failed.get(e.id);
        if (cached.has(names.frag) && cached.has(names.props)) status = "ready";
        else if (failure && failure.version_key === versionTag(e)) {
          status = "failed";
          error = failure.error;
        } else status = "processing";
      }
      return { entry: e, folder, status, error };
    })
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: "base" }));
  const result = { at: Date.now(), files };
  listings.set(project.id, result);
  for (const f of files) if (f.status === "processing") enqueueConversion(project, f.entry);
  return result;
}

const invalidate = (project) => listings.delete(project.id);

function sendStream(res, { stream, size }, headers) {
  res.set(headers);
  if (size) res.set("Content-Length", String(size));
  return pipeline(stream, res).catch((err) => {
    if (!res.headersSent) throw err;
    res.destroy(err); // connection already streaming: just cut it
  });
}

api.get("/projects/:pid/files", projectCtx, needRole("viewer"), async (req, res) => {
  const { files } = await listing(req.project);
  res.json({
    role: req.role,
    files: files.map(({ entry, folder, status, error }) => ({
      id: fileKey(req.project, entry),
      folder,
      name: entry.name,
      size: entry.size,
      status,
      error,
      updated_at: entry.modified,
      uploaded_by: entry.modifiedBy,
    })),
  });
});

api.post("/projects/:pid/files", projectCtx, needRole("designer"), uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const name = uploadedName(req.file);
    const ext = extOf(name);
    if (!FOLDERS.includes(ext)) return res.status(400).json({ error: "Only PDF, DWG and IFC files can be uploaded." });
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });

    let entry;
    try {
      entry = await storage.create(req.project, name, tmp);
    } catch (err) {
      if (err.code === "exists") {
        return res.status(409).json({ error: `"${name}" already exists in the ${ext.toUpperCase()} folder. Use Replace to upload a new version.` });
      }
      throw err;
    }
    invalidate(req.project);
    await audit(req, "file_uploaded", { projectId: req.project.id, fileId: fileKey(req.project, entry), detail: name });
    res.status(201).json({ id: fileKey(req.project, entry), name, folder: ext });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

// Status of one IFC file's converted copy (looked up directly, not from the cached listing).
async function ifcStatus(project, entry) {
  const names = cacheNames(entry);
  const cached = await storage.cacheList(project);
  if (cached.has(names.frag) && cached.has(names.props)) return { status: "ready", error: null };
  const failure = await db.one("SELECT version_key, error FROM conversion_failures WHERE project_id = $1 AND item_id = $2", [project.id, entry.id]);
  if (failure?.version_key === versionTag(entry)) return { status: "failed", error: failure.error };
  enqueueConversion(project, entry);
  return { status: "processing", error: null };
}

api.get("/files/:fid", fileCtx, needRole("viewer"), loadFile, async (req, res) => {
  const e = req.entry;
  const folder = extOf(e.name);
  const { status, error } = folder === "ifc" ? await ifcStatus(req.project, e) : { status: "ready", error: null };
  res.json({
    id: fileKey(req.project, e),
    name: e.name,
    folder,
    modified: e.modified,
    status,
    error,
    size: e.size,
    project: { id: req.project.id, name: req.project.name },
    role: req.role,
    canDownload: can(req.role, "client"),
  });
});

// Viewer-role users may only read PDFs through the page's own scripts, not by opening the address directly.
function blockDirectOpenForViewers(req, res, next) {
  if (req.role === "viewer") {
    const mode = req.get("sec-fetch-mode");
    const dest = req.get("sec-fetch-dest");
    if (mode === "navigate" || ["document", "iframe", "embed", "object"].includes(dest)) {
      return res.status(403).json({ error: "Your access level allows viewing in the page only." });
    }
  }
  next();
}

api.get("/files/:fid/content", fileCtx, needRole("viewer"), blockDirectOpenForViewers, loadFile, async (req, res) => {
  if (extOf(req.entry.name) !== "pdf") return res.status(400).json({ error: "Only PDFs can be viewed here." });
  await audit(req, "file_viewed", { projectId: req.project.id, fileId: fileKey(req.project, req.entry), detail: req.entry.name });
  await sendStream(res, await storage.read(req.project, req.entry.id), { "Content-Type": "application/pdf", "Content-Disposition": "inline" });
});

api.get("/files/:fid/download", fileCtx, needRole("client"), loadFile, async (req, res) => {
  await audit(req, "file_downloaded", { projectId: req.project.id, fileId: fileKey(req.project, req.entry), detail: req.entry.name });
  const content = await storage.read(req.project, req.entry.id);
  res.attachment(req.entry.name);
  await sendStream(res, content, { "Content-Type": "application/octet-stream" });
});

function ifcAsset(kind, type) {
  return async (req, res) => {
    const e = req.entry;
    if (extOf(e.name) !== "ifc") return res.status(400).json({ error: "Not an IFC file." });
    const { status } = await ifcStatus(req.project, e);
    if (status !== "ready") return res.status(409).json({ error: status === "failed" ? "This model could not be converted." : "This model is still being prepared." });
    if (kind === "frag") await audit(req, "file_viewed", { projectId: req.project.id, fileId: fileKey(req.project, e), detail: e.name });
    await sendStream(res, await storage.cacheRead(req.project, cacheNames(e)[kind]), { "Content-Type": type });
  };
}
api.get("/files/:fid/fragments", fileCtx, needRole("viewer"), loadFile, ifcAsset("frag", "application/octet-stream"));
api.get("/files/:fid/properties", fileCtx, needRole("viewer"), loadFile, ifcAsset("props", "application/json"));

api.put("/files/:fid", fileCtx, needRole("designer"), loadFile, uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    const e = req.entry;
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const ext = extOf(e.name);
    if (extOf(uploadedName(req.file)) !== ext) return res.status(400).json({ error: `The new file must be a ${ext.toUpperCase()} file.` });
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });

    await storage.replace(req.project, e.id, tmp);
    invalidate(req.project);
    await audit(req, "file_replaced", { projectId: req.project.id, fileId: fileKey(req.project, e), detail: e.name });
    res.json({ ok: true });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

api.patch("/files/:fid", fileCtx, needRole("designer"), loadFile, async (req, res) => {
  const e = req.entry;
  const ext = extOf(e.name);
  let name = sanitizeName(cleanText(req.body?.name, 200));
  if (!name) return res.status(400).json({ error: "Enter a file name." });
  if (extOf(name) !== ext) name = `${name}.${ext}`;
  if (name === e.name) return res.json({ name, id: fileKey(req.project, e) });
  let renamed;
  try {
    renamed = await storage.rename(req.project, e.id, name);
  } catch (err) {
    if (err.code === "exists") return res.status(409).json({ error: "A file with that name already exists." });
    throw err;
  }
  invalidate(req.project);
  await audit(req, "file_renamed", { projectId: req.project.id, fileId: fileKey(req.project, e), detail: `${e.name} to ${name}` });
  res.json({ name, id: fileKey(req.project, renamed) });
});

api.delete("/files/:fid", fileCtx, needRole("designer"), loadFile, async (req, res) => {
  const e = req.entry;
  await storage.remove(req.project, e.id); // SharePoint keeps it in the recycle bin
  invalidate(req.project);
  await db.run("DELETE FROM conversion_failures WHERE project_id = $1 AND item_id = $2", [req.project.id, e.id]);
  storage.cachePurge(req.project, `${e.id}_`).catch(() => {});
  await audit(req, "file_deleted", { projectId: req.project.id, detail: e.name });
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: "Not found." }));

// ---------- IFC conversion queue (one at a time to keep memory use low) ----------
const queue = [];
const queued = new Set(); // "<project>/<item>/<version>" for jobs waiting or running
let converting = false;

function enqueueConversion(project, entry) {
  const key = `${project.id}/${entry.id}/${versionTag(entry)}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ key, project, entry });
  pump();
}

async function pump() {
  if (converting) return;
  converting = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await convertJob(job);
      } finally {
        queued.delete(job.key);
      }
    }
  } finally {
    converting = false;
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function convertJob({ project, entry }) {
  try {
    const { stream } = await storage.read(project, entry.id);
    // Loaded on first use: the IFC libraries are large, and most of the time the server never needs them.
    const { convertIfc } = await import("./convert.js");
    const { fragmentBytes, properties } = await convertIfc(await readAll(stream));
    const current = await storage.get(project, entry.id);
    if (!current || versionTag(current) !== versionTag(entry)) return; // replaced or removed meanwhile; a newer job follows
    const names = cacheNames(entry);
    await storage.cacheWrite(project, names.props, Buffer.from(JSON.stringify(properties)));
    await storage.cacheWrite(project, names.frag, Buffer.from(fragmentBytes));
    await storage.cachePurge(project, `${entry.id}_`, [names.frag, names.props]);
    await db.run("DELETE FROM conversion_failures WHERE project_id = $1 AND item_id = $2", [project.id, entry.id]);
  } catch (err) {
    console.error(`IFC conversion failed for ${entry.name}:`, err);
    if (err instanceof StorageError && err.code === "unavailable") return; // storage hiccup: try again on next view
    await db
      .run(
        `INSERT INTO conversion_failures (project_id, item_id, version_key, error, ts) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id, item_id) DO UPDATE SET version_key = EXCLUDED.version_key, error = EXCLUDED.error, ts = EXCLUDED.ts`,
        [project.id, entry.id, versionTag(entry), String(err?.message ?? err).slice(0, 300), now()]
      )
      .catch(() => {});
  } finally {
    invalidate(project);
  }
}

// ---------- pages (dev: Vite middleware, prod: static build) ----------
const webRoot = path.join(rootDir, "web");

function pageFor(url) {
  const pathname = url.split("?")[0];
  if (pathname.startsWith("/p/")) return "project.html";
  if (pathname.startsWith("/view/ifc/")) return "model.html";
  if (pathname.startsWith("/view/pdf/")) return "pdf.html";
  if (pathname === "/admin") return "admin.html";
  return "index.html";
}

if (isProd) {
  const distDir = path.join(webRoot, "dist");
  app.use(express.static(distDir, { index: false }));
  app.get("/{*splat}", (req, res) => res.sendFile(path.join(distDir, pageFor(req.originalUrl))));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ root: webRoot, server: { middlewareMode: true }, appType: "custom" });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    try {
      let template = await fsp.readFile(path.join(webRoot, pageFor(req.originalUrl)), "utf8");
      template = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(template);
    } catch (err) {
      vite.ssrFixStacktrace(err);
      next(err);
    }
  });
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof StorageError) {
    if (err.code === "missing") return res.status(404).json({ error: "File not found." });
    if (err.code === "exists") return res.status(409).json({ error: "A file with that name already exists." });
    console.error(err);
    return res.status(502).json({ error: "The file store (SharePoint) isn't reachable right now. Try again in a moment." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const mb = (n) => Math.round(n / 1048576);
app.listen(port, () => {
  console.log(`Project file site running at http://localhost:${port} (memory ${mb(process.memoryUsage().rss)} MB)`);
});

// Once a minute: memory use, and how late the event loop is running (a stalled server shows up here).
let last = Date.now();
setInterval(() => {
  const lag = Date.now() - last - 60_000;
  last = Date.now();
  const m = process.memoryUsage();
  console.log(`Heartbeat: memory ${mb(m.rss)} MB (heap ${mb(m.heapUsed)} MB), event-loop delay ${Math.max(0, lag)} ms`);
}, 60_000).unref();
