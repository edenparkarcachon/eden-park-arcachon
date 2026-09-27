// Espace admin : campagnes de soldes et promotions.
//   GET /api/admin/sales → { campaigns, history, official }
//   PUT /api/admin/sales { campaigns } → enregistre (affichage mis à jour à la prochaine publication ;
//       le paiement applique déjà les nouveaux prix)

import { getCatalog } from "../lib/catalog.mjs";
import { getCampaigns, saveCampaigns, cleanCampaigns, getPriceHistory, officialSalesPeriods, parisDate } from "../lib/pricing.mjs";
import { markPending } from "../lib/publish.mjs";
import { json, isAuthorized, unauthorized } from "../lib/http.mjs";

export default async (req) => {
  if (!isAuthorized(req)) return unauthorized();
  const year = +parisDate().slice(0, 4);
  const official = [...officialSalesPeriods(year), ...officialSalesPeriods(year + 1)];

  if (req.method === "GET") {
    return json(200, { campaigns: await getCampaigns(), history: await getPriceHistory(), official, today: parisDate() });
  }
  if (req.method !== "PUT") return json(405, { error: "Méthode non autorisée" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide" }); }
  const { campaigns, error } = cleanCampaigns(body.campaigns, await getCatalog());
  if (error) return json(400, { error });
  await saveCampaigns(campaigns);
  const publish = await markPending("Soldes & promotions");
  return json(200, { campaigns, publish, official });
};

export const config = { path: "/api/admin/sales" };
