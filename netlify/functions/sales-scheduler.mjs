// Tâche planifiée : chaque nuit, si une promotion commence aujourd'hui ou s'est terminée hier,
// relance la construction du site pour mettre à jour les prix affichés (une seule fois par jour).
// Deux horaires (22 h 05 et 23 h 05 UTC) pour tomber juste après minuit à Paris été comme hiver.

import { getCatalog } from "../lib/catalog.mjs";
import { getOffers, parisDate } from "../lib/pricing.mjs";
import { publishNow } from "../lib/publish.mjs";
import { store } from "../lib/store.mjs";

const yesterday = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// Vrai si une réduction démarre `today` ou s'est terminée la veille (exporté pour les tests)
export function boundaryToday(offersBySlug, today) {
  return Object.values(offersBySlug).flat().some((o) => o.starts === today || o.ends === yesterday(today));
}

export default async () => {
  if (!process.env.BUILD_HOOK_URL) return;
  const today = parisDate();
  const s = await store("sales");
  const last = await s.get("scheduler", { type: "json" });
  if (last && last.day === today) return; // déjà fait aujourd'hui
  if (!boundaryToday(await getOffers(await getCatalog()), today)) return;
  const { ok } = await publishNow();
  if (ok) await s.setJSON("scheduler", { day: today, at: new Date().toISOString() });
  console.log(`Soldes & promotions : mise à jour du site pour le ${today} (${ok ? "lancée" : "échec"})`);
};

export const config = { schedule: "5 22,23 * * *" };
