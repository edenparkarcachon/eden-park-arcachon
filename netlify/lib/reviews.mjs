// Avis clients : déposés depuis les fiches produits, modérés dans l'admin.
// Store "reviews", clé "all" : [{ id, slug, name, rating, text, email, date, status, verified }]
//   status : "pending" (à modérer), "approved" (publié), "rejected" (masqué)
// L'e-mail n'est jamais publié : il sert seulement à vérifier l'achat.

import { store } from "./store.mjs";

export async function getReviews() {
  return (await (await store("reviews")).get("all", { type: "json" })) || [];
}

export async function saveReviews(list) {
  await (await store("reviews")).setJSON("all", list);
}

// Avis publiés, par produit, sans données personnelles (pour la génération du site)
export function publicReviews(list) {
  const out = {};
  for (const r of list.filter((x) => x.status === "approved").sort((a, b) => b.date.localeCompare(a.date))) {
    (out[r.slug] ||= []).push({ name: r.name, rating: r.rating, text: r.text, date: r.date.slice(0, 10), verified: !!r.verified });
  }
  return out;
}

// Limite le nombre d'avis déposés par adresse IP (anti-spam) : 3 par heure
export async function allowFrom(ip) {
  if (!ip) return true;
  const s = await store("reviews");
  const key = `ip-${Buffer.from(ip).toString("base64url")}`;
  const now = Date.now();
  const recent = ((await s.get(key, { type: "json" })) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 3) return false;
  recent.push(now);
  await s.setJSON(key, recent);
  return true;
}
