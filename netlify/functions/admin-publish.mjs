// Publication groupée des modifications de l'admin.
//   GET  /api/admin/publish → { pending: [...], lastPublished, configured }
//   POST /api/admin/publish → relance la construction du site (une mise en ligne)

import { getPublishState, publishNow } from "../lib/publish.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  const configured = !!process.env.BUILD_HOOK_URL;
  if (req.method === "GET") return json(200, { ...(await getPublishState()), configured });
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  if (!configured) return json(503, { error: "Publication automatique non configurée (variable BUILD_HOOK_URL)" });
  const { ok, state } = await publishNow();
  if (!ok) return json(502, { error: "Netlify n'a pas accepté la demande de publication, réessayez dans un instant" });
  return json(200, { ...state, configured });
};

export const config = { path: "/api/admin/publish" };
