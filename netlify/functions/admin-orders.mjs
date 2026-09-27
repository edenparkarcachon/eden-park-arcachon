// Commandes enregistrées par le webhook Stripe, et leur suivi.
//   GET   /api/admin/orders → { orders } (les plus récentes d'abord)
//   PATCH /api/admin/orders { id, statut?, suivi?, note? } → met à jour le suivi d'une commande
import { store } from "../lib/store.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export const STATUTS = ["a_preparer", "prete", "expediee", "livree", "annulee"];

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  const orders = await store("orders");
  const { blobs } = await orders.list();
  const keys = blobs.map((b) => b.key).sort().reverse();

  if (req.method === "GET") {
    const list = await Promise.all(keys.slice(0, 200).map((k) => orders.get(k, { type: "json" })));
    return json(200, { orders: list.filter(Boolean).map((o) => ({ statut: "a_preparer", suivi: "", note: "", ...o })) });
  }

  if (req.method === "PATCH") {
    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
    const key = keys.find((k) => k.endsWith(`-${body.id}`));
    if (!key || !body.id) return json(404, { error: "Commande introuvable" });
    const order = await orders.get(key, { type: "json" });
    if (body.statut !== undefined) {
      if (!STATUTS.includes(body.statut)) return json(400, { error: "Statut invalide" });
      order.statut = body.statut;
    }
    if (body.suivi !== undefined) {
      const suivi = String(body.suivi).replace(/\s/g, "").toUpperCase();
      if (suivi && !/^[A-Z0-9]{8,20}$/.test(suivi)) return json(400, { error: "Numéro de suivi invalide (8 à 20 lettres ou chiffres)" });
      order.suivi = suivi;
    }
    if (body.note !== undefined) order.note = String(body.note).slice(0, 1000);
    order.maj = new Date().toISOString();
    await orders.setJSON(key, order);
    return json(200, { order });
  }

  return json(405, { error: "Méthode non autorisée" });
};

export const config = { path: "/api/admin/orders" };
