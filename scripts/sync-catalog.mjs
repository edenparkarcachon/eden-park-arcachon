// Étape de build : récupère tout ce qui a été enregistré depuis l'espace admin
// (Netlify Blobs) avant la génération des pages par build.rb :
//   catalogue → data/products.json, stock → data/stock.json,
//   réglages → data/site.json, textes des pages → data/content.json,
//   photos envoyées → src/assets/img/uploads/ (et produits/uploads/).
// Si le stockage est inaccessible en local, on garde les fichiers du dépôt.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { store } from "../netlify/lib/store.mjs";
import { publicReviews } from "../netlify/lib/reviews.mjs";
import { computeOffers } from "../netlify/lib/pricing.mjs";

// Soldes et promotions : toutes les réductions (avec prix barré légal) → data/pricing.json,
// lues par build.rb et par le navigateur, qui choisit celle active à la date du jour.
async function writePricing() {
  const catalog = await readJSON("data/products.json");
  const sales = await readJSON("data/sales.json").catch(() => ({ campaigns: [], history: {} }));
  await writeJSON("data/pricing.json", computeOffers(catalog, sales.campaigns || [], sales.history || {}));
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMG = path.join(ROOT, "src/assets/img");

const readJSON = async (f) => JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8"));
const writeJSON = (f, obj) => fs.writeFile(path.join(ROOT, f), JSON.stringify(obj, null, 2) + "\n");

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

// Toutes les photos envoyées depuis l'admin référencées dans un objet
function uploadedPaths(value, out = new Set()) {
  if (typeof value === "string") {
    if (/^(produits\/)?uploads\/[a-z0-9-]+\.jpg$/.test(value)) out.add(value);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) uploadedPaths(v, out);
  }
  return out;
}

// strict : sur Netlify, un stockage inaccessible arrête le build (le site en ligne reste intact)
export async function runSync({ strict = false } = {}) {
  let catalogStore, siteStore;
  let catalog, settings, content, reviews, campaigns, history;
  try {
    catalogStore = await store("catalog");
    siteStore = await store("site");
    catalog = await catalogStore.get("products", { type: "json" });
    settings = await siteStore.get("settings", { type: "json" });
    content = await siteStore.get("content", { type: "json" });
    reviews = await (await store("reviews")).get("all", { type: "json" });
    campaigns = await (await store("sales")).get("campaigns", { type: "json" });
    history = await (await store("sales")).get("history", { type: "json" });
  } catch (e) {
    if (strict) throw new Error(`Stockage Netlify Blobs inaccessible (${e.message}) : build interrompu, le site en ligne n'est pas modifié.`);
    console.warn(`⚠ Stockage Netlify Blobs inaccessible (${e.message}) : utilisation des fichiers data/*.json`);
    await writePricing();
    return;
  }

  if (catalog) {
    const current = await readJSON("data/products.json");
    await writeJSON("data/products.json", { _note: current._note, categories: catalog.categories, products: catalog.products });
  }
  // Stock : celui enregistré via l'admin, sinon celui du dépôt (saisi en local avant la mise en ligne)
  const products = (catalog || (await readJSON("data/products.json"))).products;
  const stockStore = await store("stock");
  const previous = await readJSON("data/stock.json").catch(() => ({}));
  const stock = {};
  let stockCount = 0;
  for (const p of products) {
    const saved = await stockStore.get(p.slug, { type: "json" });
    if (saved) stockCount++;
    stock[p.slug] = saved || previous[p.slug] || {};
  }
  await writeJSON("data/stock.json", stock);
  if (settings) await writeJSON("data/site.json", deepMerge(await readJSON("data/site.json"), settings));
  // avis publiés uniquement, sans e-mail
  if (reviews) await writeJSON("data/reviews.json", publicReviews(reviews));
  // contenu de l'admin complété par les rubriques ajoutées depuis (FAQ, Journal…)
  if (content) await writeJSON("data/content.json", deepMerge(await readJSON("data/content.json"), content));
  if (campaigns || history) {
    const current = await readJSON("data/sales.json").catch(() => ({}));
    await writeJSON("data/sales.json", { campaigns: campaigns || current.campaigns || [], history: history || current.history || {} });
  }
  await writePricing();

  const images = await store("images");
  let count = 0;
  for (const rel of uploadedPaths([catalog, content])) {
    const name = path.basename(rel);
    await fs.mkdir(path.join(IMG, path.dirname(rel)), { recursive: true });
    for (const n of [name, name.replace(/\.jpg$/, "-720.jpg")]) {
      const data = await images.get(n, { type: "arrayBuffer" });
      if (data) { await fs.writeFile(path.join(IMG, path.dirname(rel), n), Buffer.from(data)); count++; }
      else if (!(await fs.stat(path.join(IMG, path.dirname(rel), n)).catch(() => null))) console.warn(`⚠ Photo introuvable : ${n}`);
    }
  }
  console.log(`Synchronisation depuis l'admin : catalogue ${catalog ? "✓" : "–"}, stock ${stockCount ? "✓" : "–"}, réglages ${settings ? "✓" : "–"}, pages ${content ? "✓" : "–"}, avis ${reviews ? "✓" : "–"}, soldes ${campaigns ? "✓" : "–"}, ${count} photos.`);
}

// Lancé en ligne de commande (npm run build, serveur local)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSync().catch((e) => { console.error(e); process.exit(1); });
}
