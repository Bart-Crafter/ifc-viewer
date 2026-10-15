import crypto from "node:crypto";

// Two-step sign-in by email: after the password, a 6-digit code is emailed and must be entered. The code is kept only as a
// hash, works once, for ten minutes, and allows five wrong tries.

export const CODE_MINUTES = 10;
export const MAX_GUESSES = 5;

export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

// The hash is tied to the code's id, so the same digits never produce the same hash twice.
export const hashCode = (code, id, secret) => crypto.createHmac("sha256", secret).update(`${id}|${String(code).replace(/\s+/g, "")}`).digest("hex");

export function sameHash(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const maskEmail = (email) => {
  const [name, domain = ""] = String(email).split("@");
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(name.length - 1, 5)))}@${domain}`;
};

// ---------- the short-lived "password was right, now the code" ticket ----------
const keyFrom = (secret) => crypto.createHash("sha256").update(`ticket|${secret}`).digest();

export function signTicket(id, secret, ttlMs = CODE_MINUTES * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ i: id, e: Date.now() + ttlMs })).toString("base64url");
  const mac = crypto.createHmac("sha256", keyFrom(secret)).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readTicket(ticket, secret) {
  const [payload, mac] = String(ticket ?? "").split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", keyFrom(secret)).update(payload).digest("base64url");
  if (!sameHash(mac, expected)) return null;
  try {
    const { i, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return e > Date.now() ? i : null;
  } catch {
    return null;
  }
}
