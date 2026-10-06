import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

// ---------- passwords ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export async function verifyPassword(password, { salt, hash }) {
  const candidate = await scrypt(password, Buffer.from(salt, "hex"), 64);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// Used when the email doesn't exist so the response time doesn't reveal which emails are registered.
const DUMMY = await hashPassword("timing-equaliser");
export const fakeVerify = (password) => verifyPassword(password, DUMMY);

export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

export const generateTempPassword = () => crypto.randomBytes(9).toString("base64url");

// ---------- sessions ----------
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function createSessions(db) {
  const insert = db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)");
  const find = db.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.must_change, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
  );
  const extend = db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?");
  const remove = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const removeForUser = db.prepare("DELETE FROM sessions WHERE user_id = ?");
  const removeOthers = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?");
  const prune = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  setInterval(() => prune.run(Date.now()), 60 * 60 * 1000).unref();

  return {
    create(userId) {
      const token = crypto.randomBytes(32).toString("base64url");
      insert.run(sha(token), userId, new Date().toISOString(), Date.now() + SESSION_MS);
      return token;
    },
    lookup(token) {
      if (!token) return null;
      const hash = sha(token);
      const row = find.get(hash, Date.now());
      if (!row) return null;
      if (row.expires_at - Date.now() < SESSION_MS / 2) extend.run(Date.now() + SESSION_MS, hash);
      return row;
    },
    destroy: (token) => token && remove.run(sha(token)),
    destroyAllForUser: (userId) => removeForUser.run(userId),
    destroyOthers: (userId, token) => removeOthers.run(userId, sha(token)),
    maxAgeMs: SESSION_MS,
  };
}

export function readCookie(req, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || "");
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------- login throttling ----------
export function createFailureLimiter({ max, windowMs }) {
  const entries = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, e] of entries) if (e.reset < now) entries.delete(key);
  }, 5 * 60 * 1000).unref();
  return {
    blockedFor(key) {
      const e = entries.get(key);
      return e && e.reset > Date.now() && e.count >= max ? Math.ceil((e.reset - Date.now()) / 1000) : 0;
    },
    fail(key) {
      const now = Date.now();
      const e = entries.get(key);
      if (!e || e.reset < now) entries.set(key, { count: 1, reset: now + windowMs });
      else e.count += 1;
    },
    clear: (key) => entries.delete(key),
  };
}

// ---------- request guards ----------
// State-changing requests must come from our own pages: same Origin (when sent) plus a custom header
// that other sites cannot add to cross-site requests.
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.get("host");
    } catch {}
    if (!ok) return res.status(403).json({ error: "Cross-site request blocked." });
  }
  if (req.get("x-requested-with") !== "ifc-viewer") return res.status(403).json({ error: "Missing request header." });
  next();
}

export function securityHeaders(isProd) {
  return (req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
    if (isProd) {
      res.set(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "connect-src 'self' blob:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; ")
      );
    }
    next();
  };
}
