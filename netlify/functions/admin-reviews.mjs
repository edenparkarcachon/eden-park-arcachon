// Espace admin : modération des avis clients.
//   GET    /api/admin/reviews → { reviews } (les plus récents d'abord)
//   PATCH  /api/admin/reviews { id, status: "approved"|"rejected"|"pending" }
//   DELETE /api/admin/reviews { id }
// Publier ou masquer un avis nécessite une publication du site (bouton « Publier »).

import { getReviews, saveReviews } from "../lib/reviews.mjs";
import { markPending } from "../lib/publish.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  const list = await getReviews();
  if (req.method === "GET") return json(200, { reviews: list.slice().sort((a, b) => b.date.localeCompare(a.date)) });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
  const i = list.findIndex((r) => r.id === body.id);
  if (i < 0) return json(404, { error: "Avis introuvable" });
  const wasPublic = list[i].status === "approved";

  if (req.method === "PATCH") {
    if (!["approved", "rejected", "pending"].includes(body.status)) return json(400, { error: "Statut invalide" });
    list[i].status = body.status;
  } else if (req.method === "DELETE") {
    list.splice(i, 1);
  } else {
    return json(405, { error: "Méthode non autorisée" });
  }
  await saveReviews(list);
  const nowPublic = req.method === "PATCH" && body.status === "approved";
  const publish = wasPublic !== nowPublic ? await markPending("Avis clients") : null;
  return json(200, { ok: true, publish });
};

export const config = { path: "/api/admin/reviews" };
