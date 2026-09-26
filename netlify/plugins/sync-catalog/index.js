// Plugin de build Netlify : avant la génération des pages, récupère tout ce qui a été
// enregistré depuis l'espace admin (Netlify Blobs). Seuls les plugins reçoivent les
// identifiants nécessaires (SITE_ID, NETLIFY_API_TOKEN).

import { runSync } from "../../../scripts/sync-catalog.mjs";

export const onPreBuild = async ({ constants, utils }) => {
  process.env.EP_BLOBS_SITE_ID = constants.SITE_ID;
  process.env.EP_BLOBS_TOKEN = constants.NETLIFY_API_TOKEN;
  try {
    await runSync({ strict: true });
  } catch (error) {
    utils.build.failBuild(`Synchronisation du catalogue impossible : ${error.message}`, { error });
  }
};
