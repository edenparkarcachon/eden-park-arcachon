// Crée une session Stripe Checkout à partir du panier.
//
// Variables d'environnement :
//   STRIPE_SECRET_KEY  clé secrète Stripe (sk_test_… en test, sk_live_… en production)
//   SITE_URL           URL publique du site, ex. https://edenpark-arcachon.fr
//
// Prix, frais de port et disponibilité sont recalculés ici à partir du catalogue et du
// stock : le navigateur n'envoie que les références (produit, couleur, taille, quantité).
// Si un article dépasse le stock disponible, la commande passe en délai « sur commande ».

import { getCatalog, getStock, isBackorder, getSite, backorderDays } from "../lib/catalog.mjs";
import { json } from "../lib/http.mjs";

const DOMTOM = ["GP", "MQ", "GF", "RE", "YT", "PM", "BL", "MF", "WF", "PF", "NC"];
const MAX_QTY = 10;

// Encode un objet imbriqué au format attendu par l'API Stripe (a[b][0][c]=…)
export function encode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

function shippingRate(name, amount, min, max, unit = "business_day") {
  return {
    shipping_rate_data: {
      type: "fixed_amount",
      display_name: name,
      fixed_amount: { amount, currency: "eur" },
      tax_behavior: "inclusive",
      delivery_estimate: { minimum: { unit, value: min }, maximum: { unit, value: max } },
    },
  };
}

// Construit les paramètres de la session (exporté pour les tests).
export async function buildSession(payload, siteUrl) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 30) : [];
  const zone = ["metro", "domtom", "retrait"].includes(payload.zone) ? payload.zone : "metro";
  const catalog = await getCatalog();
  const site = await getSite();
  const BACKORDER_DAYS = backorderDays(site);

  const lineItems = [];
  const metadata = { mode_livraison: zone };
  let subtotal = 0;
  let backorder = false;
  for (const [i, it] of items.entries()) {
    const p = catalog.products.find((x) => x.slug === it.slug);
    const qty = Math.min(MAX_QTY, Math.max(1, parseInt(it.qty, 10) || 0));
    if (!p || !p.colors.some((c) => c.name === it.color) || !p.sizes.includes(it.size)) {
      return { error: "Un article du panier n'est plus disponible" };
    }
    const late = isBackorder(await getStock(p.slug), it.color, it.size, qty);
    backorder = backorder || late;
    subtotal += p.price * qty;
    const photo = p.images.find((im) => im.src && !im.placeholder);
    const name = p.name.replace(/[«»]/g, "").replace(/\s+/g, " ").trim();
    lineItems.push({
      quantity: qty,
      price_data: {
        currency: "eur",
        unit_amount: p.price,
        tax_behavior: "inclusive",
        product_data: {
          name: `${name} – ${it.color}${it.size !== "Taille unique" ? ` – ${it.size}` : ""}${late ? " (sur commande)" : ""}`,
          images: photo ? [`${siteUrl}/assets/img/${photo.src}`] : undefined,
          metadata: { slug: p.slug, couleur: it.color, taille: it.size },
        },
      },
    });
    // une clé par article : lue par le webhook pour décompter le stock
    metadata[`item_${i}`] = [p.slug, it.color, it.size, qty].join("|").slice(0, 500);
  }
  if (!lineItems.length) return { error: "Panier vide" };
  metadata.sur_commande = backorder ? "oui" : "non";

  const s = site.shipping;
  const lateLabel = ` – expédition sous ${BACKORDER_DAYS} jours (sur commande)`;
  let shippingOptions;
  let countries;
  if (zone === "retrait") {
    shippingOptions = [backorder
      ? shippingRate(`Retrait en boutique – disponible sous ${BACKORDER_DAYS} jours (sur commande)`, 0, BACKORDER_DAYS - 3, BACKORDER_DAYS, "day")
      : shippingRate("Retrait en boutique – 296 bd de la Plage, Arcachon", 0, 1, 2)];
  } else if (zone === "domtom") {
    shippingOptions = [backorder
      ? shippingRate(`Colissimo – DOM-TOM${lateLabel}`, s.domtom_price, BACKORDER_DAYS + 5, BACKORDER_DAYS + 12, "day")
      : shippingRate("Colissimo – DOM-TOM", s.domtom_price, 5, 10)];
    countries = DOMTOM;
  } else {
    const free = subtotal >= s.free_threshold;
    const base = free ? "Colissimo – offerte" : "Colissimo – France métropolitaine";
    const price = free ? 0 : s.metro_price;
    shippingOptions = [backorder
      ? shippingRate(`${base}${lateLabel}`, price, BACKORDER_DAYS - 3, BACKORDER_DAYS, "day")
      : shippingRate(base, price, 2, 4)];
    countries = ["FR"];
  }

  const message = backorder
    ? `Un ou plusieurs articles sont sur commande : votre commande vous parviendra sous ${BACKORDER_DAYS} jours environ.`
    : zone === "retrait" ? "Nous vous prévenons dès que votre commande est prête à être retirée en boutique." : null;

  const params = {
    mode: "payment",
    locale: "fr",
    line_items: lineItems,
    shipping_options: shippingOptions,
    phone_number_collection: { enabled: true },
    billing_address_collection: "required",
    success_url: `${siteUrl}/merci/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/panier/`,
    metadata,
    payment_intent_data: {
      description: `Commande Eden Park Arcachon${backorder ? " (sur commande)" : ""}`,
      metadata: { mode_livraison: zone, sur_commande: metadata.sur_commande },
    },
  };
  if (countries) params.shipping_address_collection = { allowed_countries: countries };
  if (message) params.custom_text = { submit: { message } };
  return { params, backorder };
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { demo: true, error: "Paiement non configuré" });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Requête invalide" });
  }

  const siteUrl = (process.env.SITE_URL || (await getSite()).url).replace(/\/$/, "");
  const { params, error } = await buildSession(payload, siteUrl);
  if (error) return json(400, { error });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encode(params),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", data.error);
    return json(502, { error: "Le service de paiement est momentanément indisponible" });
  }
  return json(200, { url: data.url });
};

export const config = { path: "/api/checkout" };
