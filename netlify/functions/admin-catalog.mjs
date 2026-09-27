// Espace admin : lecture et enregistrement du catalogue et du stock.
//   GET  /api/admin/catalog  → { catalog, stock }
//   PUT  /api/admin/catalog  { catalog, stock, what } → enregistre (publication via /api/admin/publish)
//   PATCH /api/admin/catalog { stock } → met à jour le stock seulement (effet immédiat).

import { getCatalog, saveCatalog, getAllStock, getStock, setStock, deleteStock, validateCatalog, variantKey } from "../lib/catalog.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";
import { markPending } from "../lib/publish.mjs";
import { recordPrices } from "../lib/pricing.mjs";

// Fusionne les cases modifiées dans le stock existant, pour ne pas écraser un décompte
// fait par une commande entre-temps. Valeur vide/null = variante non suivie.
// Les variantes qui n'existent plus (couleur ou taille retirée) sont nettoyées.
async function mergeStock(products, changes) {
  for (const p of products) {
    const valid = new Set(p.colors.flatMap((c) => p.sizes.map((s) => variantKey(c.name, s))));
    const current = await getStock(p.slug);
    const patch = (changes && changes[p.slug]) || {};
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === undefined) { if (k in current) { delete current[k]; changed = true; } continue; }
      const n = parseInt(v, 10);
      if (Number.isInteger(n) && n >= 0) { current[k] = n; changed = true; }
    }
    for (const k of Object.keys(current)) if (!valid.has(k)) { delete current[k]; changed = true; }
    if (changed) await setStock(p.slug, current);
  }
}

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();

  if (req.method === "GET") {
    const catalog = await getCatalog();
    return json(200, { catalog, stock: await getAllStock(catalog), rebuild: !!process.env.BUILD_HOOK_URL });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }

  if (req.method === "PATCH") {
    const catalog = await getCatalog();
    await mergeStock(catalog.products, body.stock);
    return json(200, { ok: true, stock: await getAllStock(catalog) });
  }

  if (req.method === "PUT") {
    const catalog = body.catalog;
    const error = validateCatalog(catalog);
    if (error) return json(400, { error });
    const previous = await getCatalog();
    await saveCatalog(catalog);
    await recordPrices(catalog); // historique des prix (prix de référence des promotions)
    // supprime le stock des produits retirés
    const kept = new Set(catalog.products.map((p) => p.slug));
    for (const p of previous.products) if (!kept.has(p.slug)) await deleteStock(p.slug);
    await mergeStock(catalog.products, body.stock);
    const publish = await markPending(body.what || "Produits");
    return json(200, { ok: true, publish, stock: await getAllStock(catalog) });
  }

  return json(405, { error: "Méthode non autorisée" });
};

export const config = { path: "/api/admin/catalog" };
