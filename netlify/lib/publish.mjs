// Publication groupée : les enregistrements de l'admin sont mis « en attente » et un seul
// bouton relance la construction du site (chaque mise en ligne consomme des crédits Netlify).
// Store "site", clé "publish" : { pending: [{ what, at }], lastPublished }

import { store } from "./store.mjs";
import { triggerRebuild } from "./http.mjs";

async function read() {
  return (await (await store("site")).get("publish", { type: "json" })) || { pending: [], lastPublished: null };
}

export async function getPublishState() {
  return read();
}

export async function markPending(what) {
  const state = await read();
  // une seule entrée par type de modification (la plus récente)
  state.pending = state.pending.filter((p) => p.what !== what).concat({ what, at: new Date().toISOString() });
  await (await store("site")).setJSON("publish", state);
  return state;
}

export async function publishNow() {
  const ok = await triggerRebuild();
  if (!ok) return { ok: false, state: await read() };
  const state = { pending: [], lastPublished: new Date().toISOString() };
  await (await store("site")).setJSON("publish", state);
  return { ok: true, state };
}
