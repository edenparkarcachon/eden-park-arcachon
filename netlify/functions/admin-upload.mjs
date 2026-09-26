// Envoi d'une photo (déjà redimensionnée en JPEG par le navigateur).
//   POST /api/admin/upload?name=polo-dune-ab12cd.jpg   (corps = image JPEG)
// La photo est stockée dans le store "images", puis copiée dans le site lors du
// prochain build (scripts/sync-catalog.mjs).

import { store } from "../lib/store.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

const MAX_BYTES = 4 * 1024 * 1024;

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  const name = new URL(req.url).searchParams.get("name") || "";
  if (!/^[a-z0-9-]+(-720)?\.jpg$/.test(name)) return json(400, { error: "Nom de fichier invalide" });
  const data = await req.arrayBuffer();
  const bytes = new Uint8Array(data);
  if (!bytes.length || bytes.length > MAX_BYTES) return json(400, { error: "Image trop lourde (4 Mo max)" });
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return json(400, { error: "Le fichier n'est pas une image JPEG" });
  const images = await store("images");
  await images.set(name, data);
  return json(200, { ok: true, name });
};

export const config = { path: "/api/admin/upload" };
