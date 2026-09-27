// Webhook Stripe : à chaque paiement confirmé, décompte le stock et enregistre la commande.
//
// Dans Stripe > Développeurs > Webhooks, créer un endpoint :
//   URL        https://edenpark-arcachon.fr/api/stripe-webhook
//   Événement  checkout.session.completed
// puis copier le « secret de signature » (whsec_…) dans la variable STRIPE_WEBHOOK_SECRET.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getStock, setStock, variantKey } from "../lib/catalog.mjs";
import { store } from "../lib/store.mjs";
import { json } from "../lib/http.mjs";
import { recordPromoUse } from "../lib/promos.mjs";

const TOLERANCE_S = 300;

export function verifySignature(body, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")).filter((a) => a.length === 2).map(([k, v]) => [k.trim(), v]));
  const signatures = header.split(",").filter((kv) => kv.trim().startsWith("v1=")).map((kv) => kv.trim().slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  return signatures.some((sig) => {
    const b = Buffer.from(sig);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

// Applique une commande payée au stock (exporté pour les tests). Idempotent.
export async function applyOrder(session) {
  const orders = await store("orders");
  const created = new Date((session.created || Date.now() / 1000) * 1000);
  const key = `${created.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${session.id}`;
  const existing = await orders.list({ prefix: "" });
  if (existing.blobs.some((b) => b.key.endsWith(`-${session.id}`))) return { duplicate: true };

  const meta = session.metadata || {};
  const items = Object.keys(meta).filter((k) => /^item_\d+$/.test(k)).sort((a, b) => +a.slice(5) - +b.slice(5)).map((k) => {
    const [slug, color, size, qty] = meta[k].split("|");
    return { slug, color, size, qty: parseInt(qty, 10) || 0 };
  });

  const recorded = [];
  for (const it of items) {
    const stock = await getStock(it.slug);
    const k = variantKey(it.color, it.size);
    const before = Number.isInteger(stock[k]) ? stock[k] : null;
    if (before !== null) {
      stock[k] = Math.max(0, before - it.qty);
      await setStock(it.slug, stock);
    }
    recorded.push({ ...it, stockAvant: before, surCommande: before !== null && it.qty > before });
  }

  if (meta.promo_code) await recordPromoUse(meta.promo_code);

  const customer = session.customer_details || {};
  const shipping = session.shipping_details || session.collected_information?.shipping_details || null;
  await orders.setJSON(key, {
    id: session.id,
    date: created.toISOString(),
    total: session.amount_total,
    zone: meta.mode_livraison,
    surCommande: recorded.some((r) => r.surCommande),
    client: { nom: customer.name || shipping?.name || "", email: customer.email || "", telephone: customer.phone || "" },
    adresse: shipping?.address || null,
    articles: recorded,
    promo: meta.promo_code || null,
    cadeau: meta.cadeau === "oui",
    messageCadeau: meta.message_cadeau || "",
    remise: parseInt(meta.remise, 10) || 0,
    // suivi de la commande dans l'admin
    statut: "a_preparer",
    suivi: "",
    note: "",
  });
  return { ok: true, items: recorded };
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });
  const body = await req.text();
  if (!verifySignature(body, req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) {
    return json(400, { error: "Signature invalide" });
  }
  const event = JSON.parse(body);
  const paid = (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid")
    || event.type === "checkout.session.async_payment_succeeded";
  if (paid) {
    await applyOrder(event.data.object);
  }
  return json(200, { received: true });
};

export const config = { path: "/api/stripe-webhook" };
