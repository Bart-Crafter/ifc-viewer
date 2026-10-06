import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { convertIfc } from "./convert.js";
import { openDb, transaction } from "./db.js";
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
const filesDir = path.join(dataDir, "files");
const tmpDir = path.join(dataDir, "tmp");
const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 300;
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");

fs.mkdirSync(filesDir, { recursive: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

const db = openDb(dataDir);
const sessions = createSessions(db);

const q = {
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  insertUser: db.prepare(
    "INSERT INTO users (id, email, name, pw_salt, pw_hash, is_admin, must_change, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ),
  project: db.prepare("SELECT * FROM projects WHERE id = ?"),
  allProjects: db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE"),
  myProjects: db.prepare(
    `SELECT p.*, m.role FROM projects p JOIN memberships m ON m.project_id = p.id
      WHERE m.user_id = ? ORDER BY p.name COLLATE NOCASE`
  ),
  membership: db.prepare("SELECT role FROM memberships WHERE project_id = ? AND user_id = ?"),
  members: db.prepare(
    `SELECT u.id, u.email, u.name, u.disabled, m.role, m.granted_at FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name COLLATE NOCASE`
  ),
  upsertMember: db.prepare(
    `INSERT INTO memberships (project_id, user_id, role, granted_by, granted_at) VALUES (?,?,?,?,?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`
  ),
  deleteMember: db.prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?"),
  filesOf: db.prepare(
    `SELECT f.id, f.folder, f.name, f.size, f.version, f.status, f.error, f.created_at, f.updated_at,
            u.name AS uploaded_by FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.project_id = ? ORDER BY f.name COLLATE NOCASE`
  ),
  fileById: db.prepare("SELECT * FROM files WHERE id = ?"),
  fileByName: db.prepare("SELECT id FROM files WHERE project_id = ? AND folder = ? AND name = ?"),
  insertFile: db.prepare(
    `INSERT INTO files (id, project_id, folder, name, size, status, uploaded_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
  ),
  activity: db.prepare(
    `SELECT a.ts, a.action, a.detail, a.file_id, u.name AS user_name, u.email AS user_email
       FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 100`
  ),
};

const now = () => new Date().toISOString();
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin, mustChange: !!u.must_change });

function audit(req, action, { projectId = null, fileId = null, detail = null } = {}) {
  db.prepare("INSERT INTO audit (ts, user_id, action, project_id, file_id, detail, ip) VALUES (?,?,?,?,?,?,?)").run(
    now(),
    req.user?.id ?? null,
    action,
    projectId,
    fileId,
    detail,
    req.ip ?? null
  );
}

// ---------- roles ----------
// viewer: view PDFs/IFC only. client: + download. designer: + upload/replace/rename/delete. admin: + manage members.
const RANK = { viewer: 1, client: 2, designer: 3, admin: 4 };
const ROLES = Object.keys(RANK);

function roleFor(user, projectId) {
  if (!user) return null;
  if (user.is_admin) return "admin";
  return q.membership.get(projectId, user.id)?.role ?? null;
}

const can = (role, min) => !!role && RANK[role] >= RANK[min];

// ---------- first-run admin ----------
async function bootstrapAdmin() {
  if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) return;
  const email = (process.env.ADMIN_EMAIL || "admin@example.com").trim();
  const fromEnv = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || generateTempPassword();
  const { salt, hash } = await hashPassword(password);
  q.insertUser.run(nanoid(12), email, "Administrator", salt, hash, 1, fromEnv ? 0 : 1, now());
  console.log(`First-run admin created: ${email}`);
  if (!fromEnv) console.log(`Temporary password (change it at first login): ${password}`);
}
await bootstrapAdmin();

// ---------- app + guards ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(securityHeaders(isProd));
app.use(express.json({ limit: "100kb" }));

const api = express.Router();
app.use("/api", api);

api.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

api.use((req, res, next) => {
  req.sessionToken = readCookie(req, "sid");
  req.user = sessions.lookup(req.sessionToken);
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

function projectCtx(req, res, next) {
  const project = q.project.get(req.params.pid);
  if (!project) return res.status(404).json({ error: "Project not found." });
  req.project = project;
  req.role = roleFor(req.user, project.id);
  next();
}

function fileCtx(req, res, next) {
  const file = q.fileById.get(req.params.fid);
  if (!file) return res.status(404).json({ error: "File not found." });
  req.file_ = file;
  req.project = q.project.get(file.project_id);
  req.role = roleFor(req.user, file.project_id);
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

  const user = q.userByEmail.get(email);
  let ok = false;
  if (user && !user.disabled) ok = await verifyPassword(password, { salt: user.pw_salt, hash: user.pw_hash });
  else await fakeVerify(password);

  if (!ok) {
    userFailures.fail(userKey);
    ipFailures.fail(ipKey);
    audit(req, "login_failed", { detail: email });
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  userFailures.clear(userKey);
  const token = sessions.create(user.id);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: sessions.maxAgeMs });
  req.user = user;
  audit(req, "login");
  res.json({ user: publicUser(user) });
});

api.post("/auth/logout", (req, res) => {
  sessions.destroy(req.sessionToken);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

api.get("/auth/me", (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

api.post("/auth/change-password", requireLogin, async (req, res) => {
  const current = typeof req.body?.current === "string" ? req.body.current : "";
  const next = req.body?.next;
  const user = q.userById.get(req.user.id);
  if (!(await verifyPassword(current, { salt: user.pw_salt, hash: user.pw_hash }))) {
    return res.status(400).json({ error: "Your current password is incorrect." });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (next === current) return res.status(400).json({ error: "Choose a different password." });
  const { salt, hash } = await hashPassword(next);
  db.prepare("UPDATE users SET pw_salt = ?, pw_hash = ?, must_change = 0 WHERE id = ?").run(salt, hash, user.id);
  sessions.destroyOthers(user.id, req.sessionToken);
  audit(req, "password_changed");
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

api.get("/admin/users", requireSiteAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS projects
         FROM users u ORDER BY u.name COLLATE NOCASE`
    )
    .all();
  res.json(rows.map(adminUserRow));
});

api.post("/admin/users", requireSiteAdmin, async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const name = cleanText(req.body?.name, 120) || email.split("@")[0];
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: "An account with that email already exists." });
  const tempPassword = generateTempPassword();
  const { salt, hash } = await hashPassword(tempPassword);
  const id = nanoid(12);
  q.insertUser.run(id, email, name, salt, hash, req.body?.isAdmin ? 1 : 0, 1, now());
  audit(req, "user_created", { detail: email });
  res.status(201).json({ user: adminUserRow(q.userById.get(id)), tempPassword });
});

api.patch("/admin/users/:uid", requireSiteAdmin, async (req, res) => {
  const user = q.userById.get(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found." });
  const isSelf = user.id === req.user.id;
  const { name, isAdmin, disabled, resetPassword } = req.body ?? {};
  if (isSelf && (isAdmin === false || disabled === true)) {
    return res.status(400).json({ error: "You can't remove your own admin access or disable your own account." });
  }
  if (typeof name === "string" && cleanText(name, 120)) {
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(cleanText(name, 120), user.id);
  }
  if (typeof isAdmin === "boolean") db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, user.id);
  if (typeof disabled === "boolean") {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, user.id);
    if (disabled) sessions.destroyAllForUser(user.id);
  }
  let tempPassword;
  if (resetPassword) {
    tempPassword = generateTempPassword();
    const { salt, hash } = await hashPassword(tempPassword);
    db.prepare("UPDATE users SET pw_salt = ?, pw_hash = ?, must_change = 1 WHERE id = ?").run(salt, hash, user.id);
    sessions.destroyAllForUser(user.id);
  }
  audit(req, "user_updated", { detail: `${user.email}${resetPassword ? " (password reset)" : ""}` });
  res.json({ user: adminUserRow(q.userById.get(user.id)), tempPassword });
});

api.delete("/admin/users/:uid", requireSiteAdmin, (req, res) => {
  const user = q.userById.get(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  audit(req, "user_deleted", { detail: user.email });
  res.status(204).end();
});

// ---------- projects ----------
api.get("/projects", requireLogin, (req, res) => {
  const rows = req.user.is_admin
    ? q.allProjects.all().map((p) => ({ ...p, role: "admin" }))
    : q.myProjects.all(req.user.id);
  res.json(rows.map((p) => ({ id: p.id, name: p.name, description: p.description, role: p.role })));
});

api.post("/projects", requireSiteAdmin, (req, res) => {
  const name = cleanText(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: "Enter a project name." });
  const id = nanoid(10);
  db.prepare("INSERT INTO projects (id, name, description, created_at, created_by) VALUES (?,?,?,?,?)").run(
    id,
    name,
    cleanText(req.body?.description, 500),
    now(),
    req.user.id
  );
  audit(req, "project_created", { projectId: id, detail: name });
  res.status(201).json({ id, name });
});

// What anyone with the link can see: just the project name.
api.get("/projects/:pid", projectCtx, (req, res) => {
  const { id, name, description } = req.project;
  res.json({ id, name, description, role: req.role, signedIn: !!req.user });
});

api.patch("/projects/:pid", projectCtx, needRole("admin"), (req, res) => {
  const name = cleanText(req.body?.name, 120) || req.project.name;
  const description = typeof req.body?.description === "string" ? cleanText(req.body.description, 500) : req.project.description;
  db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(name, description, req.project.id);
  audit(req, "project_updated", { projectId: req.project.id });
  res.json({ id: req.project.id, name, description });
});

api.delete("/projects/:pid", projectCtx, requireSiteAdmin, async (req, res) => {
  const files = db.prepare("SELECT id FROM files WHERE project_id = ?").all(req.project.id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.project.id);
  await Promise.all(files.map((f) => fsp.rm(path.join(filesDir, f.id), { recursive: true, force: true })));
  audit(req, "project_deleted", { detail: req.project.name });
  res.status(204).end();
});

api.get("/projects/:pid/qr.png", projectCtx, (req, res) => {
  const base = publicUrl || `${req.protocol}://${req.get("host")}`;
  res.type("png");
  QRCode.toFileStream(res, `${base}/p/${req.project.id}`, { width: 512, margin: 2 });
});

// ---------- project members ----------
api.get("/projects/:pid/members", projectCtx, needRole("admin"), (req, res) => {
  res.json(q.members.all(req.project.id));
});

api.post("/projects/:pid/members", projectCtx, needRole("admin"), async (req, res) => {
  const email = cleanText(req.body?.email, 200).toLowerCase();
  const role = req.body?.role;
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });

  let user = q.userByEmail.get(email);
  let tempPassword;
  if (!user) {
    tempPassword = generateTempPassword();
    const { salt, hash } = await hashPassword(tempPassword);
    const id = nanoid(12);
    q.insertUser.run(id, email, cleanText(req.body?.name, 120) || email.split("@")[0], salt, hash, 0, 1, now());
    user = q.userById.get(id);
    audit(req, "user_created", { projectId: req.project.id, detail: email });
  }
  q.upsertMember.run(req.project.id, user.id, role, req.user.id, now());
  audit(req, "access_granted", { projectId: req.project.id, detail: `${email} as ${role}` });
  res.status(201).json({ member: { id: user.id, email: user.email, name: user.name, role }, tempPassword });
});

api.patch("/projects/:pid/members/:uid", projectCtx, needRole("admin"), (req, res) => {
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });
  const user = q.userById.get(req.params.uid);
  if (!user || !q.membership.get(req.project.id, user.id)) return res.status(404).json({ error: "Member not found." });
  q.upsertMember.run(req.project.id, user.id, role, req.user.id, now());
  audit(req, "role_changed", { projectId: req.project.id, detail: `${user.email} to ${role}` });
  res.json({ ok: true });
});

api.delete("/projects/:pid/members/:uid", projectCtx, needRole("admin"), (req, res) => {
  const user = q.userById.get(req.params.uid);
  if (!user) return res.status(404).json({ error: "Member not found." });
  q.deleteMember.run(req.project.id, user.id);
  audit(req, "access_removed", { projectId: req.project.id, detail: user.email });
  res.status(204).end();
});

api.get("/projects/:pid/activity", projectCtx, needRole("admin"), (req, res) => {
  res.json(q.activity.all(req.project.id));
});

// ---------- files ----------
const FOLDERS = ["pdf", "dwg", "ifc"];

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

const sanitizeName = (name) =>
  path.basename(String(name).replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim().slice(0, 200);

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

const fileDir = (id) => path.join(filesDir, id);
const originalPath = (file) => path.join(fileDir(file.id), `original.${file.folder}`);

api.get("/projects/:pid/files", projectCtx, needRole("viewer"), (req, res) => {
  res.json({ role: req.role, files: q.filesOf.all(req.project.id) });
});

api.post("/projects/:pid/files", projectCtx, needRole("designer"), uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const name = uploadedName(req.file);
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!FOLDERS.includes(ext)) return res.status(400).json({ error: "Only PDF, DWG and IFC files can be uploaded." });
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });
    if (q.fileByName.get(req.project.id, ext, name)) {
      return res.status(409).json({ error: `"${name}" already exists in the ${ext.toUpperCase()} folder. Use Replace to upload a new version.` });
    }

    const id = nanoid(12);
    await fsp.mkdir(fileDir(id), { recursive: true });
    await fsp.rename(tmp, path.join(fileDir(id), `original.${ext}`));
    q.insertFile.run(id, req.project.id, ext, name, req.file.size, ext === "ifc" ? "processing" : "ready", req.user.id, now(), now());
    audit(req, "file_uploaded", { projectId: req.project.id, fileId: id, detail: name });
    if (ext === "ifc") enqueueConversion(id);
    res.status(201).json({ id, name, folder: ext });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

api.get("/files/:fid", fileCtx, needRole("viewer"), (req, res) => {
  const f = req.file_;
  res.json({
    id: f.id,
    name: f.name,
    folder: f.folder,
    version: f.version,
    status: f.status,
    error: f.error,
    size: f.size,
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

api.get("/files/:fid/content", fileCtx, needRole("viewer"), blockDirectOpenForViewers, (req, res) => {
  if (req.file_.folder !== "pdf") return res.status(400).json({ error: "Only PDFs can be viewed here." });
  audit(req, "file_viewed", { projectId: req.project.id, fileId: req.file_.id, detail: req.file_.name });
  res.sendFile(originalPath(req.file_), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline" } });
});

api.get("/files/:fid/download", fileCtx, needRole("client"), (req, res) => {
  audit(req, "file_downloaded", { projectId: req.project.id, fileId: req.file_.id, detail: req.file_.name });
  res.download(originalPath(req.file_), req.file_.name);
});

function ifcAsset(name, type) {
  return (req, res) => {
    const f = req.file_;
    if (f.folder !== "ifc") return res.status(400).json({ error: "Not an IFC file." });
    if (f.status !== "ready") return res.status(409).json({ error: f.status === "failed" ? "This model could not be converted." : "This model is still being prepared." });
    if (name === "model.frag") audit(req, "file_viewed", { projectId: req.project.id, fileId: f.id, detail: f.name });
    res.sendFile(path.join(fileDir(f.id), name), { headers: { "Content-Type": type } });
  };
}
api.get("/files/:fid/fragments", fileCtx, needRole("viewer"), ifcAsset("model.frag", "application/octet-stream"));
api.get("/files/:fid/properties", fileCtx, needRole("viewer"), ifcAsset("properties.json", "application/json"));

api.put("/files/:fid", fileCtx, needRole("designer"), uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    const f = req.file_;
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const ext = path.extname(uploadedName(req.file)).slice(1).toLowerCase();
    if (ext !== f.folder) return res.status(400).json({ error: `The new file must be a ${f.folder.toUpperCase()} file.` });
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });

    await fsp.rm(path.join(fileDir(f.id), "model.frag"), { force: true });
    await fsp.rm(path.join(fileDir(f.id), "properties.json"), { force: true });
    await fsp.rename(tmp, originalPath(f));
    db.prepare("UPDATE files SET size = ?, version = version + 1, status = ?, error = NULL, updated_at = ?, uploaded_by = ? WHERE id = ?").run(
      req.file.size,
      f.folder === "ifc" ? "processing" : "ready",
      now(),
      req.user.id,
      f.id
    );
    audit(req, "file_replaced", { projectId: f.project_id, fileId: f.id, detail: f.name });
    if (f.folder === "ifc") enqueueConversion(f.id);
    res.json({ ok: true, version: f.version + 1 });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

api.patch("/files/:fid", fileCtx, needRole("designer"), (req, res) => {
  const f = req.file_;
  let name = sanitizeName(cleanText(req.body?.name, 200));
  if (!name) return res.status(400).json({ error: "Enter a file name." });
  if (path.extname(name).slice(1).toLowerCase() !== f.folder) name = `${name}.${f.folder}`;
  const clash = q.fileByName.get(f.project_id, f.folder, name);
  if (clash && clash.id !== f.id) return res.status(409).json({ error: "A file with that name already exists." });
  db.prepare("UPDATE files SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), f.id);
  audit(req, "file_renamed", { projectId: f.project_id, fileId: f.id, detail: `${f.name} to ${name}` });
  res.json({ name });
});

api.delete("/files/:fid", fileCtx, needRole("designer"), async (req, res) => {
  const f = req.file_;
  db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
  await fsp.rm(fileDir(f.id), { recursive: true, force: true });
  audit(req, "file_deleted", { projectId: f.project_id, detail: f.name });
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: "Not found." }));

// ---------- IFC conversion queue (one at a time to keep memory use low) ----------
const queue = [];
let converting = false;

function enqueueConversion(fileId) {
  queue.push(fileId);
  pump();
}

async function pump() {
  if (converting) return;
  converting = true;
  try {
    while (queue.length) await convertFile(queue.shift());
  } finally {
    converting = false;
  }
}

async function convertFile(fileId) {
  const file = q.fileById.get(fileId);
  if (!file) return;
  try {
    const buffer = await fsp.readFile(originalPath(file));
    const { fragmentBytes, properties } = await convertIfc(buffer);
    const current = q.fileById.get(fileId);
    if (!current || current.version !== file.version) return; // replaced while converting; a newer job is queued
    await fsp.writeFile(path.join(fileDir(fileId), "model.frag"), fragmentBytes);
    await fsp.writeFile(path.join(fileDir(fileId), "properties.json"), JSON.stringify(properties));
    db.prepare("UPDATE files SET status = 'ready', error = NULL WHERE id = ?").run(fileId);
  } catch (err) {
    console.error(`IFC conversion failed for ${fileId}:`, err);
    db.prepare("UPDATE files SET status = 'failed', error = ? WHERE id = ?").run(String(err?.message ?? err).slice(0, 300), fileId);
  }
}

for (const row of db.prepare("SELECT id FROM files WHERE status = 'processing'").all()) enqueueConversion(row.id);

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
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(port, () => {
  console.log(`IFC viewer running at http://localhost:${port}`);
});
