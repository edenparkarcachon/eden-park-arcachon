import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

// ---------- Authentification de l'espace admin ----------
// Mot de passe : variable ADMIN_PASSWORD. Le jeton est signé (HMAC) et valable 12 h.

const TOKEN_HOURS = 12;

function secret() {
  const pwd = process.env.ADMIN_PASSWORD || "";
  return process.env.ADMIN_SECRET || createHash("sha256").update(`eden-park-arcachon:${pwd}`).digest("hex");
}

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (data) => createHmac("sha256", secret()).update(data).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // compare des empreintes de même longueur pour éviter les fuites de timing
  const h = (s) => createHash("sha256").update(String(s)).digest("hex");
  return safeEqual(h(password), h(expected));
}

export function issueToken() {
  const payload = b64(JSON.stringify({ exp: Date.now() + TOKEN_HOURS * 3600e3 }));
  return `${payload}.${sign(payload)}`;
}

export function isAuthorized(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

export const unauthorized = () => json(401, { error: "Session expirée, reconnectez-vous" });

// Déclenche une reconstruction du site (hook de build Netlify)
export async function triggerRebuild() {
  const hook = process.env.BUILD_HOOK_URL;
  if (!hook) return false;
  const res = await fetch(hook, { method: "POST" });
  return res.ok;
}
