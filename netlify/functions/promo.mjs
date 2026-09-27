// Vérifie un code promo saisi dans le panier.
//   POST /api/promo { code, items: [{ slug, color, size, qty }] } → { code, label, discount, freeShipping }
import { getCatalog } from "../lib/catalog.mjs";
import { findPromo, evaluatePromo } from "../lib/promos.mjs";
import { json } from "../lib/http.mjs";
import { getOffers, effectivePrice } from "../lib/pricing.mjs";

export function cartLines(catalog, items, offers = {}) {
  return (Array.isArray(items) ? items.slice(0, 30) : []).map((it) => {
    const p = catalog.products.find((x) => x.slug === it.slug);
    if (!p) return null;
    const eff = effectivePrice(p, offers);
    return { price: eff.price, qty: Math.min(10, Math.max(1, parseInt(it.qty, 10) || 1)), category: p.category, onSale: !!eff.offer };
  }).filter(Boolean);
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
  const promo = await findPromo(body.code);
  const catalog = await getCatalog();
  const result = evaluatePromo(promo, cartLines(catalog, body.items, await getOffers(catalog)));
  if (result.error) {
    await new Promise((r) => setTimeout(r, 300)); // freine les essais de codes en série
    return json(400, { error: result.error });
  }
  return json(200, result);
};

export const config = { path: "/api/promo" };
