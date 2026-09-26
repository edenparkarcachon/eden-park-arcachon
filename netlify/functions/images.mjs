// Sert une photo envoyée depuis l'admin, avant qu'elle ne soit intégrée au site par le build.
import { store } from "../lib/store.mjs";

export default async (req, context) => {
  const name = context.params?.name || "";
  if (!/^[a-z0-9-]+(-720)?\.jpg$/.test(name)) return new Response("Introuvable", { status: 404 });
  const images = await store("images");
  const data = await images.get(name, { type: "arrayBuffer" });
  if (!data) return new Response("Introuvable", { status: 404 });
  return new Response(data, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
};

export const config = { path: "/api/images/:name" };
