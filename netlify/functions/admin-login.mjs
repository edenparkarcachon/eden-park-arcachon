import { json, checkPassword, issueToken } from "../lib/http.mjs";

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!process.env.ADMIN_PASSWORD) return json(503, { error: "Mot de passe administrateur non configuré (variable ADMIN_PASSWORD)" });
  let body = {};
  try { body = await req.json(); } catch { /* corps vide */ }
  if (!checkPassword(body.password || "")) {
    await new Promise((r) => setTimeout(r, 800)); // ralentit les essais en série
    return json(401, { error: "Mot de passe incorrect" });
  }
  return json(200, { token: issueToken() });
};

export const config = { path: "/api/admin/login" };
