// Stock public, lu par les fiches produit et le panier : { slug: { "Couleur|Taille": n } }
import { getCatalog, getAllStock, getSite, backorderDays } from "../lib/catalog.mjs";
import { json } from "../lib/http.mjs";

export default async () => {
  const catalog = await getCatalog();
  const stock = await getAllStock(catalog);
  return json(200, { stock, backorderDays: backorderDays(await getSite()) }, { "Cache-Control": "public, max-age=30" });
};

export const config = { path: "/api/stock" };
