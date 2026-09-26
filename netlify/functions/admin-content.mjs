// Espace admin : textes et photos des pages, et réglages de la boutique.
//   GET /api/admin/content → { site, content, uploads }
//   PUT /api/admin/content { settings?, content? } → enregistre puis relance la construction du site

import bundledContent from "../../data/content.json" with { type: "json" };
import { getSite, getSettings, saveSettings, getContent, saveContent, deepMerge } from "../lib/catalog.mjs";
import { cleanSettings, checkContent } from "../lib/validate.mjs";
import { store } from "../lib/store.mjs";
import { json, isAuthorized, unauthorized, triggerRebuild } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();

  if (req.method === "GET") {
    const images = await store("images");
    const { blobs } = await images.list();
    const uploads = blobs.map((b) => b.key).filter((k) => !k.endsWith("-720.jpg")).sort().reverse();
    return json(200, { site: await getSite(), content: await getContent(), uploads, rebuild: !!process.env.BUILD_HOOK_URL });
  }

  if (req.method !== "PUT") return json(405, { error: "Méthode non autorisée" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }

  if (body.settings) {
    const { settings, error } = cleanSettings(body.settings);
    if (error) return json(400, { error });
    await saveSettings(deepMerge(await getSettings(), settings));
  }
  if (body.content) {
    const error = checkContent(body.content, bundledContent);
    if (error) return json(400, { error });
    await saveContent(body.content);
  }
  const rebuilt = await triggerRebuild();
  return json(200, { ok: true, rebuilt, site: await getSite(), content: await getContent() });
};

export const config = { path: "/api/admin/content" };
