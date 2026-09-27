// Soldes et promotions : calcul du prix réellement appliqué.
//
// Deux sources de réduction, gérées dans l'admin :
//   - prix promotionnel d'un produit : product.sale = { price (centimes), starts, ends }
//   - campagnes (onglet Soldes & promos) : store "sales", clé "campaigns"
//       { id, name, kind: "soldes"|"promotion", badge, percent, scope: "all"|"categories"|"products",
//         categories: [], products: [], starts, ends ("AAAA-MM-JJ", inclus), banner, active }
// Le client bénéficie toujours de la meilleure réduction (jamais de cumul).
//
// Prix de référence (prix barré) : article L112-1-1 du Code de la consommation → prix le plus
// bas pratiqué pendant les 30 jours précédant le début de la réduction. On garde pour cela
// l'historique des prix : store "sales", clé "history" = { slug: [{ price, from }] }.

import { store } from "./store.mjs";

export const parisDate = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function getCampaigns() {
  return (await (await store("sales")).get("campaigns", { type: "json" })) || [];
}

export async function saveCampaigns(list) {
  await (await store("sales")).setJSON("campaigns", list);
}

export async function getPriceHistory() {
  return (await (await store("sales")).get("history", { type: "json" })) || {};
}

// Enregistre les changements de prix « normal » (appelé à chaque enregistrement du catalogue)
export async function recordPrices(catalog, today = parisDate()) {
  const history = await getPriceHistory();
  let changed = false;
  for (const p of catalog.products) {
    const list = history[p.slug] || [];
    const last = list[list.length - 1];
    if (!last || last.price !== p.price) {
      list.push({ price: p.price, from: today });
      history[p.slug] = list.slice(-50);
      changed = true;
    }
  }
  if (changed) await (await store("sales")).setJSON("history", history);
  return history;
}

// Prix le plus bas pratiqué sur les 30 jours précédant `start` (prix normal ou réduction déjà appliquée)
export function referencePrice(regularHistory, currentPrice, start) {
  const from = addDays(start, -30);
  const list = (regularHistory || []).slice().sort((a, b) => a.from.localeCompare(b.from));
  if (!list.length) return currentPrice;
  let min = Infinity;
  for (let i = 0; i < list.length; i++) {
    const begin = list[i].from;
    const end = list[i + 1] ? list[i + 1].from : "9999-12-31";
    // période [begin, end) qui chevauche [from, start)
    if (begin < start && end > from) min = Math.min(min, list[i].price);
  }
  return Number.isFinite(min) ? min : currentPrice;
}

const covers = (c, p) => c.scope === "all"
  || (c.scope === "categories" && (c.categories || []).includes(p.category))
  || (c.scope === "products" && (c.products || []).includes(p.slug));

// Toutes les réductions possibles d'un produit (actives, passées ou à venir), avec leur prix barré
export function computeOffers(catalog, campaigns, history, today = parisDate()) {
  const out = {};
  for (const p of catalog.products) {
    const offers = [];
    const s = p.sale;
    if (s && Number.isInteger(s.price) && s.price > 0 && s.price < p.price) {
      offers.push({ price: s.price, starts: s.starts || "", ends: s.ends || "", label: "Promo", kind: "promotion" });
    }
    for (const c of campaigns || []) {
      if (!c.active || !covers(c, p)) continue;
      const price = Math.round(p.price * (100 - c.percent) / 100);
      if (price >= p.price) continue;
      offers.push({ price, starts: c.starts || "", ends: c.ends || "", label: c.badge || (c.kind === "soldes" ? "Soldes" : "Promo"), kind: c.kind, campaign: c.id });
    }
    for (const o of offers) {
      const start = o.starts || today;
      const from = addDays(start, -30);
      let ref = referencePrice(history && history[p.slug], p.price, start);
      // une réduction déjà pratiquée dans les 30 jours précédents compte aussi
      for (const other of offers) {
        if (other === o) continue;
        const oStart = other.starts || "0000-01-01";
        const oEnd = other.ends || "9999-12-31";
        if (oStart < start && oEnd >= from) ref = Math.min(ref, other.price);
      }
      // pas de prix barré si la « réduction » n'en est pas une par rapport au prix de référence
      o.ref = ref > o.price ? ref : null;
      o.percent = o.ref ? Math.round((1 - o.price / o.ref) * 100) : 0;
    }
    if (offers.length) out[p.slug] = offers;
  }
  return out;
}

export const isActive = (o, date) => (!o.starts || date >= o.starts) && (!o.ends || date <= o.ends);

// Meilleure réduction active à une date donnée (ou null)
export function activeOffer(offers, date = parisDate()) {
  return (offers || []).filter((o) => isActive(o, date)).sort((a, b) => a.price - b.price)[0] || null;
}

// Prix appliqué au panier et au paiement
export function effectivePrice(product, offersBySlug, date = parisDate()) {
  const o = activeOffer(offersBySlug[product.slug], date);
  return o && o.price < product.price ? { price: o.price, ref: o.ref, offer: o } : { price: product.price, ref: null, offer: null };
}

export async function getOffers(catalog) {
  return computeOffers(catalog, await getCampaigns(), await getPriceHistory());
}

// Contrôle des campagnes envoyées par l'admin
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function cleanCampaigns(input, catalog) {
  if (!Array.isArray(input)) return { error: "Liste de campagnes invalide" };
  const cats = catalog.categories.map((c) => c.slug);
  const slugs = catalog.products.map((p) => p.slug);
  const ids = new Set();
  const out = [];
  for (const c of input) {
    const name = String(c.name || "").trim();
    if (!name) return { error: "Chaque campagne doit avoir un nom" };
    const percent = parseInt(c.percent, 10);
    if (!(percent >= 1 && percent <= 90)) return { error: `« ${name} » : la réduction doit être comprise entre 1 et 90 %` };
    if (!["soldes", "promotion"].includes(c.kind)) return { error: `« ${name} » : type invalide` };
    if (!["all", "categories", "products"].includes(c.scope)) return { error: `« ${name} » : choisissez les articles concernés` };
    const categories = (c.categories || []).filter((x) => cats.includes(x));
    const products = (c.products || []).filter((x) => slugs.includes(x));
    if (c.scope === "categories" && !categories.length) return { error: `« ${name} » : cochez au moins une catégorie` };
    if (c.scope === "products" && !products.length) return { error: `« ${name} » : cochez au moins un produit` };
    for (const d of [c.starts, c.ends]) if (d && !DATE_RE.test(d)) return { error: `« ${name} » : date invalide` };
    if (!c.starts || !c.ends) return { error: `« ${name} » : indiquez une date de début et une date de fin` };
    if (c.starts > c.ends) return { error: `« ${name} » : la date de fin est avant la date de début` };
    let id = String(c.id || "").replace(/[^a-z0-9-]/g, "").slice(0, 40);
    if (!id || ids.has(id)) id = `c${Date.now().toString(36)}${out.length}`;
    ids.add(id);
    out.push({
      id, name: name.slice(0, 80), kind: c.kind, badge: String(c.badge || "").trim().slice(0, 20), percent,
      scope: c.scope, categories: c.scope === "categories" ? categories : [], products: c.scope === "products" ? products : [],
      starts: c.starts, ends: c.ends, banner: String(c.banner || "").trim().slice(0, 140), active: c.active !== false,
    });
  }
  return { campaigns: out };
}

// Dates officielles des soldes (hors dérogations départementales) : 2e mercredi de janvier et
// dernier mercredi de juin, pour 4 semaines. Sert à avertir dans l'admin.
export function officialSalesPeriods(year) {
  const wed = (d) => { while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); return d; };
  const winter = wed(new Date(Date.UTC(year, 0, 1)));
  winter.setUTCDate(winter.getUTCDate() + 7);
  const summer = new Date(Date.UTC(year, 5, 30));
  while (summer.getUTCDay() !== 3) summer.setUTCDate(summer.getUTCDate() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  return [{ starts: iso(winter), ends: iso(plus(winter, 27)) }, { starts: iso(summer), ends: iso(plus(summer, 27)) }];
}
