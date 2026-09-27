// Espace admin : codes promo (effet immédiat, sans publication du site).
//   GET /api/admin/promos → { promos }
//   PUT /api/admin/promos { promos } → enregistre

import { getCatalog } from "../lib/catalog.mjs";
import { getPromos, savePromos, cleanPromos } from "../lib/promos.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  if (req.method === "GET") return json(200, { promos: await getPromos() });
  if (req.method !== "PUT") return json(405, { error: "Méthode non autorisée" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
  const categories = (await getCatalog()).categories.map((c) => c.slug);
  const { promos, error } = cleanPromos(body.promos, await getPromos(), categories);
  if (error) return json(400, { error });
  await savePromos(promos);
  return json(200, { promos });
};

export const config = { path: "/api/admin/promos" };
