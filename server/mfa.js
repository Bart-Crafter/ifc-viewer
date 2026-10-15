import crypto from "node:crypto";

// Two-step sign-in with an authenticator app (RFC 6238 time-based codes: Microsoft Authenticator, Google Authenticator,
// 1Password, Authy...). Written against Node's crypto so there is nothing extra to install or keep patched.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export const newSecret = () => base32(crypto.randomBytes(20));

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = B32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeFor(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", unbase32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Returns the time step the code belongs to (so the caller can refuse to accept it twice), or null if it doesn't match.
// One step either side is allowed for a clock that is a little out.
export function checkCode(secret, code, afterStep = 0, now = Date.now()) {
  const given = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  let match = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(codeFor(secret, step));
    // compare every candidate so the time taken doesn't reveal which one was close
    if (crypto.timingSafeEqual(expected, Buffer.from(given)) && step > afterStep) match = step;
  }
  return match;
}

export const otpauthUri = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`Crafter Engineering:${email}`)}?secret=${secret}&issuer=${encodeURIComponent("Crafter Engineering")}&digits=${DIGITS}&period=${STEP_SECONDS}`;

export const groupSecret = (secret) => secret.match(/.{1,4}/g).join(" ");

// ---------- recovery codes: ten one-time codes, kept only as hashes ----------
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normaliseRecovery = (code) => String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString("hex"); // 10 hex characters
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha(normaliseRecovery(c))) };
}

// Returns the remaining hashes if the code was one of them (it is then used up), otherwise null.
export function useRecoveryCode(hashes, code) {
  const wanted = sha(normaliseRecovery(code));
  const index = hashes.indexOf(wanted);
  if (index < 0 || normaliseRecovery(code).length !== 10) return null;
  return hashes.filter((_, i) => i !== index);
}

// ---------- keeping the secrets safe in the database ----------
// The authenticator secret is encrypted with a key that is not in the database, so a copy of the database alone
// can't be used to produce valid codes.
const keyFrom = (secret) => crypto.createHash("sha256").update(`mfa|${secret}`).digest();

export function encrypt(text, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob, secret) {
  const [iv, tag, body] = String(blob).split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------- the short-lived "password was right, now the code" ticket ----------
export function signTicket(userId, secret, ttlMs = 5 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlMs })).toString("base64url");
  const mac = crypto.createHmac("sha256", keyFrom(secret)).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readTicket(ticket, secret) {
  const [payload, mac] = String(ticket ?? "").split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", keyFrom(secret)).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return e > Date.now() ? u : null;
  } catch {
    return null;
  }
}
