// Dépôt d'un avis client depuis une fiche produit (publié après validation dans l'admin).
//   POST /api/reviews { slug, name, rating, text, email?, consent, website (piège à robots) }
import { randomUUID } from "node:crypto";
import { getCatalog } from "../lib/catalog.mjs";
import { getReviews, saveReviews, allowFrom } from "../lib/reviews.mjs";
import { store } from "../lib/store.mjs";
import { json } from "../lib/http.mjs";

// Achat vérifié : une commande payée avec cet e-mail contient ce produit
async function isVerified(email, slug) {
  if (!email) return false;
  const orders = await store("orders");
  const { blobs } = await orders.list();
  for (const b of blobs.slice(-500)) {
    const o = await orders.get(b.key, { type: "json" });
    if (o && o.client && String(o.client.email).toLowerCase() === email && o.articles.some((a) => a.slug === slug)) return true;
  }
  return false;
}

export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  let b;
  try { b = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
  if (b.website) return json(200, { ok: true }); // robot : on fait comme si de rien n'était

  const catalog = await getCatalog();
  if (!catalog.products.some((p) => p.slug === b.slug)) return json(400, { error: "Produit inconnu" });
  const name = String(b.name || "").trim().replace(/\s+/g, " ");
  const text = String(b.text || "").trim();
  const rating = parseInt(b.rating, 10);
  const email = String(b.email || "").trim().toLowerCase();
  if (name.length < 2 || name.length > 40) return json(400, { error: "Indiquez votre prénom (2 à 40 caractères)" });
  if (!(rating >= 1 && rating <= 5)) return json(400, { error: "Choisissez une note de 1 à 5 étoiles" });
  if (text.length < 10 || text.length > 1500) return json(400, { error: "Votre avis doit faire entre 10 et 1 500 caractères" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Adresse e-mail invalide" });
  if (!b.consent) return json(400, { error: "Merci d'accepter la publication de votre avis" });
  if (!(await allowFrom(context?.ip))) return json(429, { error: "Trop d'avis envoyés, réessayez plus tard" });

  const list = await getReviews();
  list.push({ id: randomUUID(), slug: b.slug, name, rating, text, email, date: new Date().toISOString(), status: "pending", verified: await isVerified(email, b.slug) });
  await saveReviews(list);
  return json(200, { ok: true });
};

export const config = { path: "/api/reviews" };
