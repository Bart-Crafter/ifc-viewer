import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { openDb } from "./db.js";
import { FOLDERS, FOLDER_KEYS, REGISTER_NAME, ROLES, createRegister, editRegister, parseRegister } from "./register.js";
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
// ---------- roles ----------
// viewer: view PDFs/IFC only. client: + download. designer: + upload/replace/rename/delete, decide who sees which
// folder, quick-send links. admin: + manage who is on the project.
// Who holds which role is NOT in the database: it lives in each project's "Project Access.xlsx" (see register.js).
const RANK = { viewer: 1, client: 2, designer: 3, admin: 4 };

const can = (role, min) => !!role && RANK[role] >= RANK[min];
const FOLDER_BY_KEY = Object.fromEntries(FOLDERS.map((f) => [f.key, f]));

class RegisterError extends Error {}

// ---------- project folders + access register ----------
const rootRef = (project) => ({ id: project.id, drive_id: project.drive_id, item_id: project.item_id, path: project.id });

const folderIdCache = new Map(); // projectId -> { at, ids: { "01 – PDF": itemId, ... } }
async function folderIds(project, { fresh = false } = {}) {
  const hit = folderIdCache.get(project.id);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.ids;
  const ids = await storage.ensureFolders(rootRef(project), FOLDERS.map((f) => f.label));
  folderIdCache.set(project.id, { at: Date.now(), ids });
  return ids;
}

// A "ref" is where a folder lives, in the shape the storage backends expect.
async function folderRef(project, key) {
  const label = FOLDER_BY_KEY[key].label;
  const ids = await folderIds(project);
  return { id: project.id, drive_id: project.drive_id, item_id: ids[label], path: `${project.id}/${label}` };
}

const registers = new Map(); // projectId -> { at, reg }
const indexSignatures = new Map();
const REGISTER_TTL_MS = Number(process.env.REGISTER_TTL_MS) || 15_000;

// Dashboard lookups use a small copy of "who has a role where", refreshed whenever a register is read.
async function syncIndex(project, reg) {
  const rows = reg ? reg.people.map((p) => [p.email, p.role]) : [];
  const signature = JSON.stringify(rows);
  if (indexSignatures.get(project.id) === signature) return;
  await db.tx(async (t) => {
    await t.run("DELETE FROM register_index WHERE project_id = $1", [project.id]);
    for (const [email, role] of rows) await t.run("INSERT INTO register_index (project_id, email, role) VALUES ($1,$2,$3)", [project.id, email, role]);
  });
  indexSignatures.set(project.id, signature);
}

// null = the register file does not exist (nobody but site admins has access). Throws if it can't be read or understood.
async function getRegister(project, { fresh = false } = {}) {
  const hit = registers.get(project.id);
  if (!fresh && hit && Date.now() - hit.at < REGISTER_TTL_MS) return hit.reg;
  const buffer = await storage.readNamed(rootRef(project), REGISTER_NAME);
  let reg = null;
  if (buffer) {
    let parsed;
    try {
      parsed = await parseRegister(buffer);
    } catch (err) {
      console.error(`Access register for project ${project.id} is unreadable:`, err.message);
      throw new RegisterError(err.message);
    }
    reg = { ...parsed, byEmail: new Map(parsed.people.map((p) => [p.email, p])) };
  }
  registers.set(project.id, { at: Date.now(), reg });
  await syncIndex(project, reg).catch((err) => console.error("Could not update the access index:", err.message));
  return reg;
}

const registerLocks = new Map();
function withRegisterLock(projectId, task) {
  const run = (registerLocks.get(projectId) ?? Promise.resolve()).catch(() => {}).then(task);
  registerLocks.set(projectId, run);
  return run;
}

// Change the register file: read it fresh, apply one change, write it back. Serialised per project.
function mutateRegister(project, op) {
  return withRegisterLock(project.id, async () => {
    const root = rootRef(project);
    const current = await storage.readNamed(root, REGISTER_NAME);
    let next;
    try {
      next = await editRegister(current, op);
    } catch (err) {
      throw new RegisterError(err.message);
    }
    await storage.writeNamed(root, REGISTER_NAME, next);
    registers.delete(project.id);
    return getRegister(project, { fresh: true });
  });
}

// One-time per project: make sure the five folders, the register workbook and the link key exist.
async function ensureProject(project, { legacy = false } = {}) {
  await folderIds(project, { fresh: true });
  const root = rootRef(project);
  if (!(await storage.readNamed(root, REGISTER_NAME))) {
    let people = [];
    if (legacy) {
      // Projects from before the register existed: carry their people over (full folder access, as they had).
      const rows = await db.all(
        `SELECT u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1`,
        [project.id]
      );
      people = rows.map((r) => ({ email: r.email, name: r.name, role: r.role, folders: Object.fromEntries(FOLDER_KEYS.map((k) => [k, true])) }));
    }
    await storage.writeNamed(root, REGISTER_NAME, await createRegister(people));
  }
  if (!project.link_key) {
    project.link_key = nanoid(22);
    await db.run("UPDATE projects SET link_key = $1 WHERE id = $2", [project.link_key, project.id]);
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const linkCookieName = (projectId) => `lk_${projectId}`;

// What can this request do in this project? Combines the signed-in person's row in the register (if any) with
// the project link/QR (view-only access to the folders marked "public").
async function accessFor(req, project) {
  const all = new Set(FOLDER_KEYS);
  if (req.user?.is_admin) return { role: "admin", folders: all, via: "admin" };

  const linkOk = !!project.link_key && safeEqual(readCookie(req, linkCookieName(project.id)), project.link_key);
  if (!req.user && !linkOk) return { role: null, folders: new Set(), via: null };

  const reg = await getRegister(project);
  let role = null;
  let via = null;
  const folders = new Set();
  const member = req.user ? reg?.byEmail.get(req.user.email) : null;
  if (member) {
    role = member.role;
    via = "member";
    for (const k of FOLDER_KEYS) if (can(role, "designer") || member.folders[k]) folders.add(k);
  }
  if (reg && (member || linkOk)) {
    // Folders marked public are open to anyone with the link, and so to everyone on the project too.
    for (const k of FOLDER_KEYS) if (reg.publicFolders[k] && (linkOk || member)) folders.add(k);
    if (!role && linkOk) {
      role = "viewer";
      via = "link";
    }
  }
  return { role, folders, via };
}

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
  if (req.user?.must_change && !req.path.startsWith("/auth/") && !req.path.startsWith("/s/") && !req.path.endsWith("/link-session")) {
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
  req.access = await accessFor(req, project);
  req.role = req.access.role;
  next();
}

// File ids are "<projectId>~<folder>~<storage item id>". The storage item is only looked up after the role and
// folder checks, and the backend confirms it really sits in that project folder.
async function fileCtx(req, res, next) {
  const [pid, folder, ...rest] = String(req.params.fid).split("~");
  const itemId = rest.join("~");
  const project = pid && folder && itemId && FOLDER_BY_KEY[folder] ? await projectById(pid) : null;
  if (!project) return res.status(404).json({ error: "File not found." });
  req.project = project;
  req.folderKey = folder;
  req.itemId = itemId;
  req.access = await accessFor(req, project);
  req.role = req.access.role;
  next();
}

const needFolder = (req, res, next) =>
  req.access.folders.has(req.folderKey) ? next() : res.status(403).json({ error: "You don't have access to that folder." });

async function loadFile(req, res, next) {
  const ref = await folderRef(req.project, req.folderKey);
  const entry = await storage.get(ref, req.itemId);
  if (!entry) return res.status(404).json({ error: "File not found." });
  req.ref = ref;
  req.entry = entry;
  next();
}

const needRole = (min) => (req, res, next) => {
  if (!can(req.role, min)) {
    // Signed-out visitors are asked to sign in; everyone else is told they lack permission.
    if (!req.user && !req.role) return res.status(401).json({ error: "Please sign in." });
    return res.status(403).json({ error: "You don't have permission to do that." });
  }
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
    `SELECT u.*, (SELECT COUNT(*) FROM register_index r WHERE r.email = u.email)::int AS projects
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
        `SELECT p.*, r.role FROM projects p JOIN register_index r ON r.project_id = p.id
          WHERE r.email = $1 ORDER BY lower(p.name)`,
        [req.user.email]
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
  const project = {
    id: nanoid(10),
    name,
    description: cleanText(req.body?.description, 500),
    drive_id: driveId,
    item_id: itemId,
    link_key: nanoid(22),
  };
  try {
    await ensureProject(project); // creates the 01–05 folders and the access register in the Submissions folder
  } catch (err) {
    console.error("Could not set up the project folder:", err);
    return res.status(400).json({
      error:
        "The site couldn't create its folders and access file in that SharePoint folder. Check that the Microsoft app was granted the 'write' role on it.",
    });
  }
  await db.run("INSERT INTO projects (id, name, description, drive_id, item_id, link_key, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    project.id,
    project.name,
    project.description,
    project.drive_id,
    project.item_id,
    project.link_key,
    now(),
    req.user.id,
  ]);
  await audit(req, "project_created", { projectId: project.id, detail: name });
  res.status(201).json({ id: project.id, name });
});

const folderInfo = (access, role) =>
  FOLDERS.filter((f) => access.folders.has(f.key)).map((f) => ({ key: f.key, label: f.label, canUpload: can(role, "designer") }));

// What anyone with the link can see: the project name, plus what their own access allows.
api.get("/projects/:pid", projectCtx, (req, res) => {
  const { id, name, description } = req.project;
  res.json({
    id,
    name,
    description,
    role: req.role,
    via: req.access.via,
    signedIn: !!req.user,
    folders: folderInfo(req.access, req.role),
  });
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
  for (const k of FOLDER_KEYS) listings.delete(`${req.project.id}:${k}`);
  registers.delete(req.project.id);
  await audit(req, "project_deleted", { detail: req.project.name });
  res.status(204).end();
});

// ---------- the project link / QR code ----------
const baseUrl = (req) => publicUrl || `${req.protocol}://${req.get("host")}`;
const linkFor = (req, project) => `${baseUrl(req)}/p/${project.id}?k=${project.link_key}`;
const linkFailures = createFailureLimiter({ max: 30, windowMs: 15 * 60 * 1000 });

// The project page calls this with the key from the QR/link; a correct key sets a cookie that gives view-only access.
api.post("/projects/:pid/link-session", async (req, res) => {
  if (linkFailures.blockedFor(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const project = await projectById(req.params.pid);
  const key = typeof req.body?.key === "string" ? req.body.key : "";
  if (!project?.link_key || !safeEqual(key, project.link_key)) {
    linkFailures.fail(req.ip);
    return res.status(403).json({ error: "That link isn't valid any more." });
  }
  res.cookie(linkCookieName(project.id), project.link_key, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

api.get("/projects/:pid/link", projectCtx, needRole("designer"), (req, res) => {
  res.json({ url: linkFor(req, req.project), canReset: can(req.role, "admin") });
});

// Anyone holding the old link/QR loses access immediately.
api.post("/projects/:pid/link/reset", projectCtx, needRole("admin"), async (req, res) => {
  const key = nanoid(22);
  await db.run("UPDATE projects SET link_key = $1 WHERE id = $2", [key, req.project.id]);
  await audit(req, "link_reset", { projectId: req.project.id });
  res.json({ url: linkFor(req, { ...req.project, link_key: key }) });
});

api.get("/projects/:pid/qr.png", projectCtx, needRole("designer"), (req, res) => {
  res.type("png");
  QRCode.toFileStream(res, linkFor(req, req.project), { width: 512, margin: 2 });
});

// ---------- who has access (stored in the project's access register workbook) ----------
async function accessView(project, role) {
  let reg;
  try {
    reg = await getRegister(project, { fresh: true });
  } catch (err) {
    if (err instanceof RegisterError) return { error: err.message, people: [], publicFolders: {}, warnings: [] };
    throw err;
  }
  if (!reg) return { missing: true, people: [], publicFolders: {}, warnings: [] };
  const accounts = reg.people.length
    ? await db.all("SELECT email, name, disabled FROM users WHERE email = ANY($1)", [reg.people.map((p) => p.email)])
    : [];
  const byEmail = new Map(accounts.map((a) => [a.email, a]));
  return {
    people: reg.people.map((p) => ({
      email: p.email,
      name: byEmail.get(p.email)?.name || p.name || "",
      role: p.role,
      folders: p.folders,
      hasAccount: byEmail.has(p.email),
      disabled: !!byEmail.get(p.email)?.disabled,
    })),
    publicFolders: reg.publicFolders,
    warnings: reg.warnings,
  };
}

api.get("/projects/:pid/access", projectCtx, needRole("designer"), async (req, res) => {
  res.json({
    ...(await accessView(req.project, req.role)),
    folders: FOLDERS.map(({ key, label }) => ({ key, label })),
    canManagePeople: can(req.role, "admin"),
    registerName: REGISTER_NAME,
  });
});

// Recreate the register if it was deleted (admins only; starts with nobody on the project).
api.post("/projects/:pid/access/repair", projectCtx, needRole("admin"), async (req, res) => {
  await ensureProject(req.project);
  registers.delete(req.project.id);
  await audit(req, "register_repaired", { projectId: req.project.id });
  res.json({ ok: true });
});

const boolMap = (value) => Object.fromEntries(FOLDER_KEYS.filter((k) => value && k in value).map((k) => [k, !!value[k]]));

// Designers (and admins) decide which folders a viewer/client can open.
api.put("/projects/:pid/access/people/:email/folders", projectCtx, needRole("designer"), async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const reg = await getRegister(req.project, { fresh: true });
  const person = reg?.byEmail.get(email);
  if (!person) return res.status(404).json({ error: "That person isn't on this project." });
  if (can(person.role, "designer")) return res.status(400).json({ error: "Designers and admins always see every folder." });
  const folders = boolMap(req.body?.folders);
  await mutateRegister(req.project, { type: "setPerson", email, folders });
  await audit(req, "folder_access_changed", {
    projectId: req.project.id,
    detail: `${email}: ${FOLDER_KEYS.filter((k) => k in folders).map((k) => `${k}=${folders[k] ? "yes" : "no"}`).join(", ")}`,
  });
  res.json(await accessView(req.project, req.role));
});

// Which folders anyone holding the link/QR (no sign-in) can view.
api.put("/projects/:pid/access/public", projectCtx, needRole("designer"), async (req, res) => {
  const folders = boolMap(req.body?.folders);
  await mutateRegister(req.project, { type: "setPublic", folders });
  await audit(req, "public_folders_changed", {
    projectId: req.project.id,
    detail: FOLDER_KEYS.filter((k) => k in folders).map((k) => `${k}=${folders[k] ? "yes" : "no"}`).join(", "),
  });
  res.json(await accessView(req.project, req.role));
});

// ---------- project members (admins) ----------
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
  // New viewers/clients start with the folders that are already public; designers can open more up afterwards.
  const reg = await getRegister(req.project, { fresh: true });
  const folders = req.body?.folders ? boolMap(req.body.folders) : { ...(reg?.publicFolders ?? {}) };
  await mutateRegister(req.project, { type: "setPerson", email, name: user.name, role, folders });
  await audit(req, "access_granted", { projectId: req.project.id, detail: `${email} as ${role}` });
  res.status(201).json({ member: { email: user.email, name: user.name, role }, tempPassword });
});

// Registered people an admin can pick from when giving access (those not already on this project).
// Site admins see every active account. A project admin only sees people who already belong to a project that
// admin also administers, so one client's details aren't shown to another project's admin.
api.get("/projects/:pid/directory", projectCtx, needRole("admin"), async (req, res) => {
  const rows = req.user.is_admin
    ? await db.all(
        `SELECT email, name FROM users WHERE disabled = 0
            AND email NOT IN (SELECT email FROM register_index WHERE project_id = $1) ORDER BY lower(name)`,
        [req.project.id]
      )
    : await db.all(
        `SELECT email, name FROM users WHERE disabled = 0
            AND email NOT IN (SELECT email FROM register_index WHERE project_id = $1)
            AND email IN (SELECT email FROM register_index WHERE project_id IN
                  (SELECT project_id FROM register_index WHERE email = $2 AND role = 'admin'))
          ORDER BY lower(name)`,
        [req.project.id, req.user.email]
      );
  res.json(rows);
});

api.patch("/projects/:pid/members/:email", projectCtx, needRole("admin"), async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Choose a role." });
  const reg = await getRegister(req.project, { fresh: true });
  if (!reg?.byEmail.has(email)) return res.status(404).json({ error: "Member not found." });
  await mutateRegister(req.project, { type: "setPerson", email, role });
  await audit(req, "role_changed", { projectId: req.project.id, detail: `${email} to ${role}` });
  res.json({ ok: true });
});

api.delete("/projects/:pid/members/:email", projectCtx, needRole("admin"), async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  await mutateRegister(req.project, { type: "removePerson", email });
  await audit(req, "access_removed", { projectId: req.project.id, detail: email });
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
const extOf = (name) => path.extname(name).slice(1).toLowerCase();
const typeOf = (name) => {
  const ext = extOf(name);
  return ext === "pdf" || ext === "ifc" ? ext : "other";
};
const fileKey = (project, folderKey, entry) => `${project.id}~${folderKey}~${entry.id}`;
const versionTag = (entry) => crypto.createHash("sha1").update(entry.versionKey).digest("hex").slice(0, 12);
const cacheNames = (entry) => ({ frag: `${entry.id}_${versionTag(entry)}.frag`, props: `${entry.id}_${versionTag(entry)}.json` });

// Things that run or script when opened. Anything else may be stored; it is only ever offered as a download.
const BLOCKED_EXT = new Set(["exe", "dll", "bat", "cmd", "com", "msi", "scr", "js", "mjs", "vbs", "ps1", "hta", "jar", "html", "htm", "svg", "lnk", "reg"]);

function uploadProblem(folderKey, name) {
  const ext = extOf(name);
  if (!name || !ext) return "Files need a name with an extension, like drawing.pdf.";
  if (BLOCKED_EXT.has(ext)) return `.${ext} files can't be uploaded.`;
  const only = { pdf: "pdf", dwg: "dwg", ifc: "ifc" }[folderKey];
  if (only && ext !== only) return `Only .${only} files go in ${FOLDER_BY_KEY[folderKey].label}. Use 04 – CALCS or 05 – OTHER for other file types.`;
  return null;
}

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
  if (!["pdf", "ifc", "dwg"].includes(ext)) return true;
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead).toString("latin1");
    if (ext === "pdf") return head.includes("%PDF-");
    if (ext === "ifc") return /^\s*ISO-10303-21/.test(head);
    return /^AC10\d\d/.test(head);
  } finally {
    await handle.close();
  }
}

// Short-lived cache of a folder's file list (plus which IFC models are already converted) so the page and its
// polling don't hammer SharePoint. Dropped whenever this server changes something.
const listings = new Map();
const LISTING_TTL_MS = 8000;

async function listing(project, key) {
  const cacheKey = `${project.id}:${key}`;
  const hit = listings.get(cacheKey);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit;
  const ref = await folderRef(project, key);
  const [entries, cached, failures] = await Promise.all([
    storage.list(ref),
    storage.cacheList(ref),
    db.all("SELECT item_id, version_key, error FROM conversion_failures WHERE project_id = $1", [project.id]),
  ]);
  const failed = new Map(failures.map((f) => [f.item_id, f]));
  const files = entries
    .filter((e) => !e.name.startsWith("~$") && !e.name.startsWith("."))
    .map((e) => {
      let status = "ready";
      let error = null;
      if (extOf(e.name) === "ifc") {
        const names = cacheNames(e);
        const failure = failed.get(e.id);
        if (cached.has(names.frag) && cached.has(names.props)) status = "ready";
        else if (failure && failure.version_key === versionTag(e)) {
          status = "failed";
          error = failure.error;
        } else status = "processing";
      }
      return { entry: e, status, error };
    })
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: "base" }));
  const result = { at: Date.now(), ref, files };
  listings.set(cacheKey, result);
  for (const f of files) if (f.status === "processing") enqueueConversion(project, ref, f.entry);
  return result;
}

const invalidate = (project, key) => listings.delete(`${project.id}:${key}`);

function sendStream(res, { stream, size }, headers) {
  res.set(headers);
  if (size) res.set("Content-Length", String(size));
  return pipeline(stream, res).catch((err) => {
    if (!res.headersSent) throw err;
    res.destroy(err); // connection already streaming: just cut it
  });
}

api.get("/projects/:pid/files", projectCtx, needRole("viewer"), async (req, res) => {
  const keys = FOLDER_KEYS.filter((k) => req.access.folders.has(k));
  const lists = await Promise.all(keys.map((k) => listing(req.project, k)));
  const files = [];
  keys.forEach((key, i) => {
    for (const { entry, status, error } of lists[i].files) {
      files.push({
        id: fileKey(req.project, key, entry),
        folder: key,
        type: typeOf(entry.name),
        name: entry.name,
        size: entry.size,
        status,
        error,
        updated_at: entry.modified,
        uploaded_by: entry.modifiedBy,
      });
    }
  });
  res.json({ role: req.role, via: req.access.via, folders: folderInfo(req.access, req.role), files });
});

// Uploading is a deliberate act of publishing: the person confirms we may share the file (third-party drawings, maps,
// logos and standards are not ours to share). The page asks, and the server insists, so it is on record.
const RIGHTS_MESSAGE = "Please confirm you have the right to share this file before uploading it.";
const needRights = (req, res, next) => (req.query.rights === "1" ? next() : res.status(400).json({ error: RIGHTS_MESSAGE }));

api.post("/projects/:pid/folders/:folder/files", projectCtx, needRole("designer"), needRights, uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    const key = req.params.folder;
    if (!FOLDER_BY_KEY[key]) return res.status(404).json({ error: "Folder not found." });
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const name = uploadedName(req.file);
    const problem = uploadProblem(key, name);
    if (problem) return res.status(400).json({ error: problem });
    const ext = extOf(name);
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });

    let entry;
    try {
      entry = await storage.create(await folderRef(req.project, key), name, tmp);
    } catch (err) {
      if (err.code === "exists") {
        return res.status(409).json({ error: `"${name}" already exists in ${FOLDER_BY_KEY[key].label}. Use Replace to upload a new version.` });
      }
      throw err;
    }
    invalidate(req.project, key);
    await audit(req, "file_uploaded", { projectId: req.project.id, fileId: fileKey(req.project, key, entry), detail: `${name} → ${FOLDER_BY_KEY[key].label} (sharing rights confirmed)` });
    res.status(201).json({ id: fileKey(req.project, key, entry), name, folder: key });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

// Status of one IFC file's converted copy (looked up directly, not from the cached listing).
async function ifcStatus(project, ref, entry) {
  const names = cacheNames(entry);
  const cached = await storage.cacheList(ref);
  if (cached.has(names.frag) && cached.has(names.props)) return { status: "ready", error: null };
  const failure = await db.one("SELECT version_key, error FROM conversion_failures WHERE project_id = $1 AND item_id = $2", [project.id, entry.id]);
  if (failure?.version_key === versionTag(entry)) return { status: "failed", error: failure.error };
  enqueueConversion(project, ref, entry);
  return { status: "processing", error: null };
}

api.get("/files/:fid", fileCtx, needRole("viewer"), needFolder, loadFile, async (req, res) => {
  const e = req.entry;
  const type = typeOf(e.name);
  const { status, error } = type === "ifc" ? await ifcStatus(req.project, req.ref, e) : { status: "ready", error: null };
  res.json({
    id: fileKey(req.project, req.folderKey, e),
    name: e.name,
    folder: req.folderKey,
    type,
    modified: e.modified,
    status,
    error,
    size: e.size,
    project: { id: req.project.id, name: req.project.name },
    role: req.role,
    canDownload: can(req.role, "client"),
  });
});

// Viewer-role users (and link holders) may only read PDFs through the page's own scripts, not by opening the address directly.
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

const viaNote = (req) => (req.access.via === "link" ? " (via project link)" : "");

api.get("/files/:fid/content", fileCtx, needRole("viewer"), needFolder, blockDirectOpenForViewers, loadFile, async (req, res) => {
  if (typeOf(req.entry.name) !== "pdf") return res.status(400).json({ error: "Only PDFs can be viewed here." });
  await audit(req, "file_viewed", { projectId: req.project.id, fileId: fileKey(req.project, req.folderKey, req.entry), detail: req.entry.name + viaNote(req) });
  await sendStream(res, await storage.read(req.ref, req.entry.id), { "Content-Type": "application/pdf", "Content-Disposition": "inline" });
});

api.get("/files/:fid/download", fileCtx, needRole("client"), needFolder, loadFile, async (req, res) => {
  await audit(req, "file_downloaded", { projectId: req.project.id, fileId: fileKey(req.project, req.folderKey, req.entry), detail: req.entry.name });
  const content = await storage.read(req.ref, req.entry.id);
  res.attachment(req.entry.name);
  await sendStream(res, content, { "Content-Type": "application/octet-stream" });
});

function ifcAsset(kind, type) {
  return async (req, res) => {
    const e = req.entry;
    if (typeOf(e.name) !== "ifc") return res.status(400).json({ error: "Not an IFC file." });
    const { status } = await ifcStatus(req.project, req.ref, e);
    if (status !== "ready") return res.status(409).json({ error: status === "failed" ? "This model could not be converted." : "This model is still being prepared." });
    if (kind === "frag") await audit(req, "file_viewed", { projectId: req.project.id, fileId: fileKey(req.project, req.folderKey, e), detail: e.name + viaNote(req) });
    await sendStream(res, await storage.cacheRead(req.ref, cacheNames(e)[kind]), { "Content-Type": type });
  };
}
api.get("/files/:fid/fragments", fileCtx, needRole("viewer"), needFolder, loadFile, ifcAsset("frag", "application/octet-stream"));
api.get("/files/:fid/properties", fileCtx, needRole("viewer"), needFolder, loadFile, ifcAsset("props", "application/json"));

api.put("/files/:fid", fileCtx, needRole("designer"), needFolder, needRights, loadFile, uploadSingle, async (req, res) => {
  const tmp = req.file?.path;
  try {
    const e = req.entry;
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const ext = extOf(e.name);
    if (extOf(uploadedName(req.file)) !== ext) return res.status(400).json({ error: `The new file must be a .${ext} file.` });
    if (!(await looksLikeType(tmp, ext))) return res.status(400).json({ error: `That doesn't look like a valid ${ext.toUpperCase()} file.` });

    await storage.replace(req.ref, e.id, tmp);
    invalidate(req.project, req.folderKey);
    await audit(req, "file_replaced", { projectId: req.project.id, fileId: fileKey(req.project, req.folderKey, e), detail: e.name });
    res.json({ ok: true });
  } finally {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

api.patch("/files/:fid", fileCtx, needRole("designer"), needFolder, loadFile, async (req, res) => {
  const e = req.entry;
  const ext = extOf(e.name);
  let name = sanitizeName(cleanText(req.body?.name, 200));
  if (!name) return res.status(400).json({ error: "Enter a file name." });
  if (extOf(name) !== ext) name = `${name}.${ext}`;
  if (name === e.name) return res.json({ name, id: fileKey(req.project, req.folderKey, e) });
  let renamed;
  try {
    renamed = await storage.rename(req.ref, e.id, name);
  } catch (err) {
    if (err.code === "exists") return res.status(409).json({ error: "A file with that name already exists." });
    throw err;
  }
  invalidate(req.project, req.folderKey);
  await audit(req, "file_renamed", { projectId: req.project.id, fileId: fileKey(req.project, req.folderKey, e), detail: `${e.name} to ${name}` });
  res.json({ name, id: fileKey(req.project, req.folderKey, renamed) });
});

api.delete("/files/:fid", fileCtx, needRole("designer"), needFolder, loadFile, async (req, res) => {
  const e = req.entry;
  await storage.remove(req.ref, e.id); // SharePoint keeps it in the recycle bin
  invalidate(req.project, req.folderKey);
  await db.run("DELETE FROM conversion_failures WHERE project_id = $1 AND item_id = $2", [req.project.id, e.id]);
  storage.cachePurge(req.ref, `${e.id}_`).catch(() => {});
  await audit(req, "file_deleted", { projectId: req.project.id, detail: e.name });
  res.status(204).end();
});

// ---------- quick-send links ("send these files to someone without an account") ----------
// A link is valid for 3 days, can be cancelled, and gives access to exactly the files the sender picked,
// never to the project, its folders or its people.
const SHARE_DAYS = Number(process.env.SHARE_DAYS) || 3; // fixed at 3 in production; overridable only so tests can check expiry
const shareFailures = createFailureLimiter({ max: 40, windowMs: 15 * 60 * 1000 });
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

api.post("/projects/:pid/shares", projectCtx, needRole("designer"), async (req, res) => {
  const ids = Array.isArray(req.body?.files) ? [...new Set(req.body.files.map(String))].slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ error: "Choose at least one file to send." });
  const picked = [];
  for (const id of ids) {
    const [pid, folder, ...rest] = id.split("~");
    const itemId = rest.join("~");
    if (pid !== req.project.id || !FOLDER_BY_KEY[folder] || !itemId || !req.access.folders.has(folder)) {
      return res.status(400).json({ error: "One of the chosen files isn't in this project." });
    }
    const entry = await storage.get(await folderRef(req.project, folder), itemId);
    if (!entry) return res.status(400).json({ error: "One of the chosen files no longer exists." });
    picked.push({ folder, item_id: itemId, name: entry.name, size: entry.size });
  }
  const token = nanoid(28);
  const shareId = nanoid(10);
  const expires = new Date(Date.now() + SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.tx(async (t) => {
    await t.run("INSERT INTO shares (id, project_id, token_hash, created_by, created_at, expires_at, message) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      shareId,
      req.project.id,
      hashToken(token),
      req.user?.id ?? null,
      now(),
      expires,
      cleanText(req.body?.message, 500),
    ]);
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      await t.run("INSERT INTO share_files (share_id, position, folder, item_id, name, size) VALUES ($1,$2,$3,$4,$5,$6)", [shareId, i, f.folder, f.item_id, f.name, f.size]);
    }
  });
  await audit(req, "share_created", { projectId: req.project.id, detail: `${picked.length} file(s): ${picked.map((f) => f.name).join(", ").slice(0, 300)}` });
  res.status(201).json({ id: shareId, url: `${baseUrl(req)}/s/${token}`, expiresAt: expires, files: picked.length });
});

// Active links for this project (people see their own; admins see everyone's). The address itself is shown only once.
api.get("/projects/:pid/shares", projectCtx, needRole("designer"), async (req, res) => {
  const mine = can(req.role, "admin") ? "" : "AND s.created_by = $3";
  const params = [req.project.id, now(), ...(mine ? [req.user?.id ?? ""] : [])];
  const rows = await db.all(
    `SELECT s.id, s.created_at, s.expires_at, s.message, u.name AS created_by_name,
            (SELECT COUNT(*) FROM share_files f WHERE f.share_id = s.id)::int AS files
       FROM shares s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.project_id = $1 AND s.revoked = 0 AND s.expires_at > $2 ${mine} ORDER BY s.created_at DESC`,
    params
  );
  res.json(rows);
});

api.delete("/projects/:pid/shares/:sid", projectCtx, needRole("designer"), async (req, res) => {
  const share = await db.one("SELECT id, created_by FROM shares WHERE id = $1 AND project_id = $2", [req.params.sid, req.project.id]);
  if (!share) return res.status(404).json({ error: "Link not found." });
  if (!can(req.role, "admin") && share.created_by !== req.user?.id) return res.status(403).json({ error: "You can only cancel links you created." });
  await db.run("UPDATE shares SET revoked = 1 WHERE id = $1", [share.id]);
  await audit(req, "share_cancelled", { projectId: req.project.id });
  res.status(204).end();
});

// Public side: no sign-in. The token in the address is the only credential.
async function shareByToken(req, res) {
  if (shareFailures.blockedFor(req.ip)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return null;
  }
  const share = await db.one(
    `SELECT s.*, u.name AS sender FROM shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.token_hash = $1`,
    [hashToken(String(req.params.token))]
  );
  if (!share || share.revoked || share.expires_at <= now()) {
    shareFailures.fail(req.ip);
    res.status(404).json({ error: "This link has expired or doesn't exist." });
    return null;
  }
  share.files = await db.all("SELECT position, folder, item_id, name, size FROM share_files WHERE share_id = $1 ORDER BY position", [share.id]);
  return share;
}

// The shared file, if it still exists in its folder.
async function shareFile(share, f) {
  const project = await projectById(share.project_id);
  if (!project) return null;
  const ref = await folderRef(project, f.folder);
  const entry = await storage.get(ref, f.item_id);
  return entry ? { project, ref, entry } : null;
}

api.get("/s/:token", async (req, res) => {
  const share = await shareByToken(req, res);
  if (!share) return;
  res.set("X-Robots-Tag", "noindex");
  res.json({
    sender: share.sender || "Crafter Engineering",
    message: share.message,
    expiresAt: share.expires_at,
    files: share.files.map((f) => ({ n: f.position, name: f.name, size: f.size })),
  });
});

api.get("/s/:token/files/:n", async (req, res) => {
  const share = await shareByToken(req, res);
  if (!share) return;
  const f = share.files.find((x) => String(x.position) === req.params.n);
  const found = f && (await shareFile(share, f));
  if (!found) return res.status(404).json({ error: "That file is no longer available." });
  await audit(req, "share_downloaded", { projectId: share.project_id, detail: found.entry.name });
  const content = await storage.read(found.ref, found.entry.id);
  res.attachment(found.entry.name);
  res.set("X-Robots-Tag", "noindex");
  await sendStream(res, content, { "Content-Type": "application/octet-stream" });
});

api.get("/s/:token/zip", async (req, res) => {
  const share = await shareByToken(req, res);
  if (!share) return;
  const found = [];
  for (const f of share.files) {
    const hit = await shareFile(share, f);
    if (hit) found.push(hit);
  }
  if (!found.length) return res.status(404).json({ error: "These files are no longer available." });
  await audit(req, "share_downloaded", { projectId: share.project_id, detail: `all (${found.length} files, zip)` });
  const { ZipArchive } = await import("archiver");
  const archive = new ZipArchive({ store: true }); // PDFs and models are already compact; storing keeps CPU and memory low
  res.attachment("Crafter Engineering files.zip");
  res.set("X-Robots-Tag", "noindex");
  archive.on("error", (err) => {
    console.error("Zip failed:", err);
    res.destroy(err);
  });
  archive.pipe(res);
  const used = new Set();
  for (const { ref, entry } of found) {
    let name = entry.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = entry.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(name.toLowerCase());
    // opened only when the zip reaches this file, so one big download never holds many connections open
    archive.append(
      Readable.from(
        (async function* () {
          const { stream } = await storage.read(ref, entry.id);
          yield* stream;
        })()
      ),
      { name }
    );
  }
  await archive.finalize();
});

api.use((req, res) => res.status(404).json({ error: "Not found." }));

// ---------- IFC conversion queue (one at a time to keep memory use low) ----------
const queue = [];
const queued = new Set(); // "<project>/<item>/<version>" for jobs waiting or running
let converting = false;

function enqueueConversion(project, ref, entry) {
  const key = `${project.id}/${entry.id}/${versionTag(entry)}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ key, project, ref, entry });
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

async function convertJob({ project, ref, entry }) {
  try {
    const { stream } = await storage.read(ref, entry.id);
    // Loaded on first use: the IFC libraries are large, and most of the time the server never needs them.
    const { convertIfc } = await import("./convert.js");
    const { fragmentBytes, properties } = await convertIfc(await readAll(stream));
    const current = await storage.get(ref, entry.id);
    if (!current || versionTag(current) !== versionTag(entry)) return; // replaced or removed meanwhile; a newer job follows
    const names = cacheNames(entry);
    await storage.cacheWrite(ref, names.props, Buffer.from(JSON.stringify(properties)));
    await storage.cacheWrite(ref, names.frag, Buffer.from(fragmentBytes));
    await storage.cachePurge(ref, `${entry.id}_`, [names.frag, names.props]);
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
    for (const k of FOLDER_KEYS) invalidate(project, k);
  }
}

// ---------- pages (dev: Vite middleware, prod: static build) ----------
const webRoot = path.join(rootDir, "web");

function pageFor(url) {
  const pathname = url.split("?")[0];
  if (pathname.startsWith("/p/")) return "project.html";
  if (pathname.startsWith("/s/")) return "share.html";
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
  if (err instanceof RegisterError) {
    return res.status(503).json({
      error: `This project's access file (${REGISTER_NAME}) couldn't be read, so access can't be checked. Ask an administrator to check it.`,
    });
  }
  if (err instanceof StorageError) {
    if (err.code === "missing") return res.status(404).json({ error: "File not found." });
    if (err.code === "exists") return res.status(409).json({ error: "A file with that name already exists." });
    console.error(err);
    return res.status(502).json({ error: "The file store (SharePoint) isn't reachable right now. Try again in a moment." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

// ---------- background jobs ----------
// After an upgrade (or a restart) make sure every project has its folders, access register and link key.
async function setUpProjects() {
  for (const project of await db.all("SELECT * FROM projects")) {
    try {
      await ensureProject(project, { legacy: !project.link_key });
    } catch (err) {
      console.error(`Could not set up project ${project.name}:`, err.message);
    }
  }
}
setUpProjects().catch((err) => console.error("Project setup failed:", err));

// Changes made by hand in the Excel file reach the dashboard's project list within a few minutes.
async function refreshRegisters() {
  for (const project of await db.all("SELECT * FROM projects")) {
    await getRegister(project, { fresh: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
}
setInterval(() => refreshRegisters().catch(() => {}), Number(process.env.REGISTER_REFRESH_MS) || 5 * 60_000).unref();

// Expired quick-send links are kept for a week (for the activity log), then removed.
setInterval(
  () => db.run("DELETE FROM shares WHERE expires_at < $1", [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]).catch(() => {}),
  60 * 60_000
).unref();

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
