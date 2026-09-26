// Contrôles des données envoyées par l'espace admin.

// Chemin de photo relatif à assets/img/, sans remontée de dossier
export const IMG_RE = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(jpg|svg)$/;
// Lien : page du site ("/…") ou adresse https
const LINK_RE = /^(\/[^\s"'<>]*|https:\/\/[^\s"'<>]+)$/;

// Parcourt un objet et vérifie toutes les photos ("src") et tous les liens (clés "…link")
export function checkTree(value, path = "") {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) { const e = checkTree(v, `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "src" && v !== "" && v != null && !IMG_RE.test(String(v))) return `Photo invalide (${path}.${k})`;
      if (/link$/.test(k) && v && !LINK_RE.test(String(v))) return `Lien invalide : « ${v} » (doit commencer par / ou https://)`;
      if (typeof v === "string" && v.length > 5000) return `Texte trop long (${path}.${k})`;
      const e = checkTree(v, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const str = (v, max = 300) => typeof v === "string" && v.length <= max;

// Ne garde que les réglages modifiables depuis l'admin, et les vérifie.
export function cleanSettings(input) {
  const s = input || {};
  const out = {};
  if (s.phone !== undefined) { if (!str(s.phone, 30) || !/^[\d\s+().-]{6,}$/.test(s.phone)) return { error: "Numéro de téléphone invalide" }; out.phone = s.phone.trim(); }
  if (s.email !== undefined) { if (!str(s.email, 120) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return { error: "Adresse e-mail invalide" }; out.email = s.email.trim(); }
  if (s.address) {
    const a = s.address;
    if (![a.street, a.postal_code, a.city].every((v) => str(v, 120) && v.trim())) return { error: "Adresse incomplète" };
    out.address = { street: a.street.trim(), postal_code: a.postal_code.trim(), city: a.city.trim() };
  }
  if (s.geo) {
    const lat = Number(s.geo.lat), lng = Number(s.geo.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return { error: "Coordonnées GPS invalides" };
    out.geo = { lat, lng };
  }
  if (s.hours) {
    if (!Array.isArray(s.hours) || !s.hours.length || s.hours.length > 7) return { error: "Horaires invalides" };
    out.hours = [];
    for (const r of s.hours) {
      if (!str(r.days, 60) || !r.days.trim()) return { error: "Chaque ligne d'horaires doit avoir un libellé (ex. « Lundi – Samedi »)" };
      if (!Array.isArray(r.schema_days) || !r.schema_days.length || !r.schema_days.every((d) => DAYS.includes(d))) return { error: `Cochez les jours concernés pour « ${r.days} »` };
      if (!Array.isArray(r.opens) || !Array.isArray(r.closes) || !r.opens.length || r.opens.length !== r.closes.length
        || ![...r.opens, ...r.closes].every((t) => TIME_RE.test(t))) return { error: `Horaires invalides pour « ${r.days} » (format 10:00-13:00, 14:30-19:00)` };
      out.hours.push({ days: r.days.trim(), schema_days: r.schema_days, opens: r.opens, closes: r.closes });
    }
  }
  if (s.social) {
    for (const k of ["instagram", "facebook"]) {
      if (s.social[k] && !/^https:\/\/[^\s"'<>]+$/.test(s.social[k])) return { error: `Lien ${k} invalide (doit commencer par https://)` };
    }
    out.social = { instagram: s.social.instagram || "", facebook: s.social.facebook || "" };
  }
  if (s.shipping) {
    const sh = s.shipping;
    if (!int(sh.metro_price, 0, 100000) || !int(sh.domtom_price, 0, 100000) || !int(sh.free_threshold, 0, 10000000)) return { error: "Tarifs de livraison invalides" };
    if (!int(sh.backorder_days, 1, 120)) return { error: "Le délai « sur commande » doit être compris entre 1 et 120 jours" };
    if (!str(sh.metro_delay, 60) || !str(sh.domtom_delay, 60)) return { error: "Délais de livraison invalides" };
    out.shipping = { metro_price: sh.metro_price, domtom_price: sh.domtom_price, free_threshold: sh.free_threshold, backorder_days: sh.backorder_days, metro_delay: sh.metro_delay.trim(), domtom_delay: sh.domtom_delay.trim() };
  }
  if (s.return_days !== undefined) { if (!int(s.return_days, 14, 365)) return { error: "Le délai de retour doit être d'au moins 14 jours (minimum légal)" }; out.return_days = s.return_days; }
  if (s.legal) {
    out.legal = {};
    for (const k of ["capital", "mediator", "director"]) { if (s.legal[k] !== undefined) { if (!str(s.legal[k], 400)) return { error: "Mentions légales invalides" }; out.legal[k] = s.legal[k].trim(); } }
  }
  if (s.analytics_id !== undefined) { if (s.analytics_id && !/^G-[A-Z0-9]{4,}$/.test(s.analytics_id)) return { error: "Identifiant Google Analytics invalide (format G-XXXXXXX)" }; out.analytics_id = s.analytics_id || "G-XXXXXXXXXX"; }
  if (s.description !== undefined) { if (!str(s.description, 300)) return { error: "Description trop longue" }; out.description = s.description.trim(); }
  if (s.email !== undefined) out.email_provisional = false;
  return { settings: out };
}

// Vérifie la structure du contenu des pages (mêmes rubriques que data/content.json)
export function checkContent(content, reference) {
  if (!content || typeof content !== "object") return "Contenu invalide";
  for (const k of Object.keys(reference)) {
    if (k.startsWith("_")) continue;
    if (!(k in content)) return `Rubrique manquante : ${k}`;
    if (Array.isArray(reference[k]) !== Array.isArray(content[k])) return `Format invalide : ${k}`;
  }
  return checkTree(content);
}
