// Codes promo, gérés depuis l'admin (onglet Codes promo).
// Store "promos", clé "codes" : liste de
//   { code, type: "percent"|"amount"|"shipping", percent, amount (centimes),
//     min_order (centimes), starts, ends ("AAAA-MM-JJ" ou ""), max_uses (0 = illimité),
//     uses (compteur), categories ([] = toutes), active, note }

import { store } from "./store.mjs";

export const normalizeCode = (c) => String(c || "").trim().toUpperCase();

export async function getPromos() {
  return (await (await store("promos")).get("codes", { type: "json" })) || [];
}

export async function savePromos(list) {
  await (await store("promos")).setJSON("codes", list);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Contrôle et nettoie la liste envoyée par l'admin. Les compteurs d'utilisation sont
// repris du serveur (l'admin ne peut que les remettre à zéro explicitement).
export function cleanPromos(input, current, categories) {
  if (!Array.isArray(input)) return { error: "Liste de codes invalide" };
  const seen = new Set();
  const out = [];
  for (const p of input) {
    const code = normalizeCode(p.code);
    if (!/^[A-Z0-9-]{3,30}$/.test(code)) return { error: `Code « ${p.code || ""} » invalide : 3 à 30 caractères, lettres, chiffres ou tirets` };
    if (seen.has(code)) return { error: `Le code ${code} existe deux fois` };
    seen.add(code);
    if (!["percent", "amount", "shipping"].includes(p.type)) return { error: `Type de réduction invalide pour ${code}` };
    const percent = parseInt(p.percent, 10) || 0;
    const amount = parseInt(p.amount, 10) || 0;
    if (p.type === "percent" && (percent < 1 || percent > 100)) return { error: `Pourcentage invalide pour ${code} (entre 1 et 100)` };
    if (p.type === "amount" && amount <= 0) return { error: `Montant de réduction invalide pour ${code}` };
    const min = parseInt(p.min_order, 10) || 0;
    if (min < 0) return { error: `Montant minimum invalide pour ${code}` };
    for (const d of [p.starts, p.ends]) if (d && !DATE_RE.test(d)) return { error: `Date invalide pour ${code}` };
    if (p.starts && p.ends && p.starts > p.ends) return { error: `Pour ${code}, la date de fin est avant la date de début` };
    const maxUses = parseInt(p.max_uses, 10) || 0;
    if (maxUses < 0) return { error: `Nombre d'utilisations invalide pour ${code}` };
    const cats = Array.isArray(p.categories) ? p.categories.filter((c) => categories.includes(c)) : [];
    const previous = current.find((x) => x.code === code);
    out.push({
      code, type: p.type, percent: p.type === "percent" ? percent : 0, amount: p.type === "amount" ? amount : 0,
      min_order: min, starts: p.starts || "", ends: p.ends || "", max_uses: maxUses,
      uses: p.reset_uses ? 0 : (previous ? previous.uses || 0 : 0),
      categories: cats, active: p.active !== false, note: String(p.note || "").slice(0, 200),
    });
  }
  return { promos: out };
}

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ

// Calcule l'effet d'un code sur un panier.
// lines : [{ price (centimes, unitaire), qty, category }]
export function evaluatePromo(promo, lines, now = today()) {
  if (!promo || !promo.active) return { error: "Ce code promo n'existe pas" };
  if (promo.starts && now < promo.starts) return { error: "Ce code promo n'est pas encore valable" };
  if (promo.ends && now > promo.ends) return { error: "Ce code promo a expiré" };
  if (promo.max_uses && (promo.uses || 0) >= promo.max_uses) return { error: "Ce code promo a atteint son nombre maximum d'utilisations" };
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  if (promo.min_order && subtotal < promo.min_order) {
    return { error: `Ce code est valable dès ${(promo.min_order / 100).toLocaleString("fr-FR")} € d'achat` };
  }
  const eligible = lines.filter((l) => !promo.categories.length || promo.categories.includes(l.category))
    .reduce((s, l) => s + l.price * l.qty, 0);
  if (promo.type !== "shipping" && eligible === 0) return { error: "Ce code ne s'applique à aucun article de votre panier" };
  let discount = 0;
  if (promo.type === "percent") discount = Math.round(eligible * promo.percent / 100);
  if (promo.type === "amount") discount = Math.min(promo.amount, eligible);
  const label = promo.type === "percent" ? `-${promo.percent} %` : promo.type === "amount" ? `-${(promo.amount / 100).toLocaleString("fr-FR")} €` : "Livraison offerte";
  return { code: promo.code, discount, freeShipping: promo.type === "shipping", label };
}

export async function findPromo(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return (await getPromos()).find((p) => p.code === c) || null;
}

export async function recordPromoUse(code) {
  const c = normalizeCode(code);
  const list = await getPromos();
  const p = list.find((x) => x.code === c);
  if (!p) return;
  p.uses = (p.uses || 0) + 1;
  await savePromos(list);
}
