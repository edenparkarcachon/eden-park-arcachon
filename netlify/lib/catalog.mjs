// Catalogue et stock partagés par toutes les fonctions.
//
// - Catalogue : store "catalog", clé "products" (même format que data/products.json).
//   Tant que l'admin n'a rien enregistré, on utilise data/products.json livré avec le site.
// - Stock : store "stock", une clé par produit : { "Marine|M": 3, "Marine|L": 0, ... }.
//   Une variante absente ou vide (null) = stock non suivi (considérée disponible).

import bundledCatalog from "../../data/products.json" with { type: "json" };
import bundledSite from "../../data/site.json" with { type: "json" };
import bundledContent from "../../data/content.json" with { type: "json" };
import bundledStock from "../../data/stock.json" with { type: "json" };
import { store } from "./store.mjs";
import { checkTree, IMG_RE } from "./validate.mjs";

// ---------- Réglages de la boutique (onglet Réglages de l'admin) ----------
// Store "site", clé "settings" : uniquement les champs modifiables, fusionnés sur data/site.json.

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export async function getSettings() {
  return (await (await store("site")).get("settings", { type: "json" })) || {};
}

export async function getSite() {
  return deepMerge(bundledSite, await getSettings());
}

export async function saveSettings(settings) {
  await (await store("site")).setJSON("settings", settings);
}

export const backorderDays = (site) => site.shipping.backorder_days || 15;

// ---------- Textes et photos des pages (onglet Pages & photos) ----------
export async function getContent() {
  return (await (await store("site")).get("content", { type: "json" })) || bundledContent;
}

export async function saveContent(content) {
  await (await store("site")).setJSON("content", content);
}

export const variantKey = (color, size) => `${color}|${size}`;

export async function getCatalog() {
  const s = await store("catalog");
  const saved = await s.get("products", { type: "json" });
  return saved || bundledCatalog;
}

export async function saveCatalog(catalog) {
  const s = await store("catalog");
  await s.setJSON("products", catalog);
}

// Stock d'un produit. Tant que rien n'a été enregistré en ligne pour ce produit, on part
// du stock saisi en local (data/stock.json, écrit par le serveur de développement).
export async function getStock(slug) {
  const s = await store("stock");
  const saved = await s.get(slug, { type: "json" });
  if (saved) return saved;
  return process.env.EP_IGNORE_BUNDLED_STOCK ? {} : { ...(bundledStock[slug] || {}) };
}

export async function setStock(slug, stock) {
  const s = await store("stock");
  await s.setJSON(slug, stock);
}

export async function deleteStock(slug) {
  const s = await store("stock");
  // on enregistre un stock vide plutôt que de supprimer, pour ne pas retomber sur data/stock.json
  await s.setJSON(slug, {});
}

export async function getAllStock(catalog) {
  const entries = await Promise.all(catalog.products.map(async (p) => [p.slug, await getStock(p.slug)]));
  return Object.fromEntries(entries);
}

// Quantité disponible pour une variante : un nombre, ou null si le stock n'est pas suivi.
export function available(stockOfProduct, color, size) {
  const v = stockOfProduct ? stockOfProduct[variantKey(color, size)] : undefined;
  return Number.isInteger(v) ? v : null;
}

export function isBackorder(stockOfProduct, color, size, qty) {
  const a = available(stockOfProduct, color, size);
  return a !== null && qty > a;
}

// Contrôle d'un catalogue envoyé par l'admin. Renvoie un message d'erreur ou null.
export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.products) || !Array.isArray(catalog.categories)) return "Format de catalogue invalide";
  if (!catalog.categories.length) return "Il faut au moins une catégorie";
  const cats = new Set();
  for (const c of catalog.categories) {
    if (!c.name || !String(c.name).trim()) return "Une catégorie n'a pas de nom";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug || "")) return `Adresse invalide pour la catégorie « ${c.name} »`;
    if (cats.has(c.slug)) return `Deux catégories utilisent l'adresse « ${c.slug} »`;
    if (c.image && !IMG_RE.test(c.image)) return `Photo invalide pour la catégorie « ${c.name} »`;
    cats.add(c.slug);
  }
  const treeError = checkTree(catalog);
  if (treeError) return treeError;
  const slugs = new Set();
  for (const p of catalog.products) {
    const label = p.name || p.slug || "(sans nom)";
    if (!p.name || !String(p.name).trim()) return "Un produit n'a pas de nom";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug || "")) return `Adresse (slug) invalide pour « ${label} »`;
    if (slugs.has(p.slug)) return `L'adresse « ${p.slug} » est utilisée par deux produits`;
    slugs.add(p.slug);
    if (!cats.has(p.category)) return `Catégorie inconnue pour « ${label} »`;
    if (!Number.isInteger(p.price) || p.price <= 0) return `Prix invalide pour « ${label} »`;
    if (!Array.isArray(p.colors) || !p.colors.length) return `Ajoutez au moins une couleur à « ${label} »`;
    if (!Array.isArray(p.sizes) || !p.sizes.length) return `Ajoutez au moins une taille à « ${label} »`;
    if (!Array.isArray(p.images)) return `Photos invalides pour « ${label} »`;
    if (p.related !== undefined && (!Array.isArray(p.related) || p.related.some((x) => !/^[a-z0-9-]+$/.test(String(x))))) return `Produits associés invalides pour « ${label} »`;
    if (p.sale) {
      const s = p.sale;
      if (!Number.isInteger(s.price) || s.price <= 0 || s.price >= p.price) return `« ${label} » : le prix promotionnel doit être inférieur au prix normal`;
      for (const d of [s.starts, s.ends]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return `« ${label} » : date de promotion invalide`;
      if (s.starts && s.ends && s.starts > s.ends) return `« ${label} » : la fin de la promotion est avant son début`;
    }
  }
  return null;
}
