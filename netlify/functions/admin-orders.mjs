// Dernières commandes enregistrées par le webhook Stripe (les plus récentes d'abord).
import { store } from "../lib/store.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  const orders = await store("orders");
  const { blobs } = await orders.list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 100);
  const list = await Promise.all(keys.map((k) => orders.get(k, { type: "json" })));
  return json(200, { orders: list.filter(Boolean) });
};

export const config = { path: "/api/admin/orders" };
