// Tests des fonctions serveur (admin, stock, paiement, webhook) sur un stockage temporaire.
//   node scripts/test-api.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "ep-test-"));
process.env.LOCAL_STORE_DIR = dir;
process.env.ADMIN_PASSWORD = "secret-test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
delete process.env.BUILD_HOOK_URL;
process.env.EP_IGNORE_BUNDLED_STOCK = "1";

const login = (await import("../netlify/functions/admin-login.mjs")).default;
const adminCatalog = (await import("../netlify/functions/admin-catalog.mjs")).default;
const upload = (await import("../netlify/functions/admin-upload.mjs")).default;
const images = (await import("../netlify/functions/images.mjs")).default;
const stockFn = (await import("../netlify/functions/stock.mjs")).default;
const orders = (await import("../netlify/functions/admin-orders.mjs")).default;
const webhookMod = await import("../netlify/functions/stripe-webhook.mjs");
const { buildSession } = await import("../netlify/functions/checkout.mjs");

const U = "http://localhost/api";
const req = (url, method = "GET", body, headers = {}) => new Request(U + url, {
  method, headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)),
});
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

console.log("Connexion");
await test("mauvais mot de passe refusé", async () => {
  assert.equal((await login(req("/admin/login", "POST", { password: "non" }))).status, 401);
});
await test("bon mot de passe → jeton", async () => {
  const r = await login(req("/admin/login", "POST", { password: "secret-test" }));
  assert.equal(r.status, 200);
  token = (await r.json()).token;
  assert.ok(token.includes("."));
});
await test("accès admin sans jeton ou jeton falsifié refusé", async () => {
  assert.equal((await adminCatalog(req("/admin/catalog"))).status, 401);
  const forged = token.split(".")[0] + ".AAAA";
  assert.equal((await adminCatalog(req("/admin/catalog", "GET", undefined, { Authorization: `Bearer ${forged}` }))).status, 401);
});

console.log("Catalogue");
let catalog;
await test("lecture du catalogue initial (data/products.json)", async () => {
  const r = await adminCatalog(req("/admin/catalog", "GET", undefined, auth()));
  catalog = (await r.json()).catalog;
  assert.equal(catalog.products.length, 6);
});
await test("catalogue invalide refusé (adresse en double)", async () => {
  const bad = structuredClone(catalog);
  bad.products[1].slug = bad.products[0].slug;
  const r = await adminCatalog(req("/admin/catalog", "PUT", { catalog: bad }, auth()));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /deux produits/);
});
await test("ajout d'un produit avec son stock", async () => {
  const c = structuredClone(catalog);
  c.products.push({ slug: "bob-bassin", name: "Bob « Bassin »", category: "casquettes-accessoires", price: 3900, colors: [{ name: "Écru", hex: "#efe8da" }], sizes: ["Taille unique"], images: [], short: "Bob brodé.", description: [], details: [], badges: [], fit: "", care: "" });
  const r = await adminCatalog(req("/admin/catalog", "PUT", { catalog: c, stock: { "bob-bassin": { "Écru|Taille unique": 4 } } }, auth()));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.stock["bob-bassin"]["Écru|Taille unique"], 4);
  catalog = c;
});

console.log("Stock");
await test("saisie du stock (fusion, n'écrase pas les autres cases)", async () => {
  let r = await adminCatalog(req("/admin/catalog", "PATCH", { stock: { "polo-dune-du-pyla": { "Marine|M": 2, "Marine|L": 0, "Marine|XL": 5 } } }, auth()));
  assert.equal(r.status, 200);
  r = await adminCatalog(req("/admin/catalog", "PATCH", { stock: { "polo-dune-du-pyla": { "Marine|XL": null } } }, auth()));
  const s = (await r.json()).stock["polo-dune-du-pyla"];
  assert.deepEqual(s, { "Marine|M": 2, "Marine|L": 0 });
});
await test("stock public exposé sur /api/stock", async () => {
  const d = await (await stockFn(req("/stock"))).json();
  assert.equal(d.stock["polo-dune-du-pyla"]["Marine|M"], 2);
  assert.equal(d.backorderDays, 15);
});

console.log("Délai de livraison (paiement)");
const cart = (size, qty, zone = "metro") => ({ items: [{ slug: "polo-dune-du-pyla", color: "Marine", size, qty }], zone });
await test("article en stock → délai normal 2 à 4 jours ouvrés", async () => {
  const { params, backorder } = await buildSession(cart("M", 1), "https://x.fr");
  assert.equal(backorder, false);
  const est = params.shipping_options[0].shipping_rate_data.delivery_estimate;
  assert.deepEqual([est.minimum.value, est.maximum.value, est.maximum.unit], [2, 4, "business_day"]);
  assert.equal(params.metadata.item_0, "polo-dune-du-pyla|Marine|M|1");
});
await test("stock à 0 → sur commande, délai 15 jours", async () => {
  const { params, backorder } = await buildSession(cart("L", 1), "https://x.fr");
  assert.equal(backorder, true);
  const rate = params.shipping_options[0].shipping_rate_data;
  assert.match(rate.display_name, /15 jours/);
  assert.equal(rate.delivery_estimate.maximum.value, 15);
  assert.equal(rate.delivery_estimate.maximum.unit, "day");
  assert.match(params.custom_text.submit.message, /15 jours/);
  assert.match(params.line_items[0].price_data.product_data.name, /sur commande/);
});
await test("quantité supérieure au stock → sur commande", async () => {
  assert.equal((await buildSession(cart("M", 3), "https://x.fr")).backorder, true);
});
await test("stock non suivi → délai normal", async () => {
  assert.equal((await buildSession(cart("S", 5), "https://x.fr")).backorder, false);
});
await test("retrait en boutique sur commande → disponible sous 15 jours", async () => {
  const { params } = await buildSession(cart("L", 1, "retrait"), "https://x.fr");
  assert.match(params.shipping_options[0].shipping_rate_data.display_name, /Retrait.*15 jours/);
});
await test("prix recalculé côté serveur (le navigateur ne fixe pas le prix)", async () => {
  const { params } = await buildSession({ items: [{ slug: "polo-dune-du-pyla", color: "Marine", size: "M", qty: 1, price: 1 }], zone: "metro" }, "https://x.fr");
  assert.equal(params.line_items[0].price_data.unit_amount, 11900);
});
await test("variante inexistante refusée", async () => {
  assert.ok((await buildSession({ items: [{ slug: "polo-dune-du-pyla", color: "Vert", size: "M", qty: 1 }] }, "https://x.fr")).error);
});

console.log("Webhook Stripe (décompte du stock)");
const signed = (payload, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) => {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return req("/stripe-webhook", "POST", body, { "Stripe-Signature": `t=${t},v1=${sig}` });
};
const session = async () => {
  const { params } = await buildSession({ items: [{ slug: "polo-dune-du-pyla", color: "Marine", size: "M", qty: 1 }, { slug: "polo-dune-du-pyla", color: "Marine", size: "L", qty: 1 }, { slug: "bob-bassin", color: "Écru", size: "Taille unique", qty: 1 }], zone: "metro" }, "https://x.fr");
  return { type: "checkout.session.completed", data: { object: { id: "cs_test_1", created: Math.floor(Date.now() / 1000), payment_status: "paid", amount_total: 27700, metadata: params.metadata, customer_details: { name: "Jean Test", email: "jean@test.fr" } } } };
};
await test("signature invalide refusée", async () => {
  const r = await webhookMod.default(signed(await session(), "whsec_autre"));
  assert.equal(r.status, 400);
});
await test("signature trop ancienne refusée", async () => {
  const r = await webhookMod.default(signed(await session(), "whsec_test", Math.floor(Date.now() / 1000) - 3600));
  assert.equal(r.status, 400);
});
await test("paiement confirmé → stock décompté", async () => {
  const r = await webhookMod.default(signed(await session()));
  assert.equal(r.status, 200);
  const d = await (await stockFn(req("/stock"))).json();
  assert.equal(d.stock["polo-dune-du-pyla"]["Marine|M"], 1, "M : 2 → 1");
  assert.equal(d.stock["polo-dune-du-pyla"]["Marine|L"], 0, "L reste à 0 (sur commande)");
  assert.equal(d.stock["bob-bassin"]["Écru|Taille unique"], 3, "bob : 4 → 3");
});
await test("même événement reçu deux fois → pas de double décompte", async () => {
  await webhookMod.default(signed(await session()));
  const d = await (await stockFn(req("/stock"))).json();
  assert.equal(d.stock["polo-dune-du-pyla"]["Marine|M"], 1);
});
await test("commande visible dans l'admin, article épuisé marqué « sur commande »", async () => {
  const d = await (await orders(req("/admin/orders", "GET", undefined, auth()))).json();
  assert.equal(d.orders.length, 1);
  const o = d.orders[0];
  assert.equal(o.surCommande, true);
  assert.deepEqual(o.articles.map((a) => a.surCommande), [false, true, false]);
  assert.equal(o.client.email, "jean@test.fr");
});

console.log("Photos");
await test("fichier non JPEG refusé", async () => {
  const r = await upload(new Request(`${U}/admin/upload?name=test-abc.jpg`, { method: "POST", headers: auth(), body: new Uint8Array([1, 2, 3]) }));
  assert.equal(r.status, 400);
});
await test("nom de fichier dangereux refusé", async () => {
  const r = await upload(new Request(`${U}/admin/upload?name=../../x.jpg`, { method: "POST", headers: auth(), body: new Uint8Array([0xff, 0xd8, 0xff]) }));
  assert.equal(r.status, 400);
});
await test("photo JPEG enregistrée puis servie", async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const r = await upload(new Request(`${U}/admin/upload?name=bob-bassin-abc123.jpg`, { method: "POST", headers: auth(), body: jpg }));
  assert.equal(r.status, 200);
  const g = await images(req("/images/bob-bassin-abc123.jpg"), { params: { name: "bob-bassin-abc123.jpg" } });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await g.arrayBuffer()), jpg);
});

console.log("Réglages, pages et catégories");
const adminContent = (await import("../netlify/functions/admin-content.mjs")).default;
await test("réglages : livraison et délai « sur commande » modifiés → utilisés au paiement", async () => {
  const r = await adminContent(req("/admin/content", "PUT", { settings: { shipping: { metro_price: 590, domtom_price: 1800, free_threshold: 9000, backorder_days: 21, metro_delay: "2 à 3 jours ouvrés", domtom_delay: "7 jours" } } }, auth()));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const { params } = await buildSession({ items: [{ slug: "polo-dune-du-pyla", color: "Marine", size: "L", qty: 1 }], zone: "metro" }, "https://x.fr");
  assert.match(params.shipping_options[0].shipping_rate_data.display_name, /21 jours/);
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0, "119 € ≥ 90 € → livraison offerte");
  assert.equal((await (await stockFn(req("/stock"))).json()).backorderDays, 21);
});
await test("réglages : horaires et coordonnées enregistrés, champs protégés ignorés", async () => {
  const r = await adminContent(req("/admin/content", "PUT", { settings: {
    phone: "05 56 00 00 00", email: "boutique@edenpark-arcachon.fr",
    hours: [{ days: "Tous les jours", schema_days: ["Monday", "Sunday"], opens: ["09:30"], closes: ["19:30"] }],
    legal: { capital: "1 000 €", siret: "PIRATE" } } }, auth()));
  const d = await r.json();
  assert.equal(d.site.phone, "05 56 00 00 00");
  assert.equal(d.site.hours.length, 1);
  assert.equal(d.site.legal.capital, "1 000 €");
  assert.equal(d.site.legal.siret, "911 065 852 00012", "le SIRET n'est pas modifiable");
});
await test("réglages invalides refusés (retour < 14 jours, horaire mal écrit, e-mail)", async () => {
  for (const bad of [{ return_days: 7 }, { email: "pas-un-email" }, { hours: [{ days: "Lun", schema_days: ["Monday"], opens: ["25:00"], closes: ["19:00"] }] }]) {
    assert.equal((await adminContent(req("/admin/content", "PUT", { settings: bad }, auth()))).status, 400, JSON.stringify(bad));
  }
});
const content = (await (await adminContent(req("/admin/content", "GET", undefined, auth()))).json()).content;
await test("pages : texte et photo de la bannière modifiés", async () => {
  const c = structuredClone(content);
  c.home.hero.title = "Nouveau titre";
  c.home.hero.image.src = "uploads/bob-bassin-abc123.jpg";
  const r = await adminContent(req("/admin/content", "PUT", { content: c }, auth()));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).content.home.hero.title, "Nouveau titre");
});
await test("pages : chemin de photo piégé refusé", async () => {
  const c = structuredClone(content);
  c.home.hero.image.src = "../../../etc/passwd.jpg";
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: c }, auth()))).status, 400);
});
await test("pages : lien javascript: refusé", async () => {
  const c = structuredClone(content);
  c.home.hero.cta1_link = "javascript:alert(1)";
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: c }, auth()))).status, 400);
});
await test("pages : sans être connecté → refusé", async () => {
  assert.equal((await adminContent(req("/admin/content", "PUT", { content })) ).status, 401);
});
await test("catégories : ajout d'une catégorie avec photo", async () => {
  const c = structuredClone(catalog);
  c.categories.push({ slug: "chemises", name: "Chemises", title: "Chemises", intro: "", meta_title: "", meta_description: "", image: "uploads/chemise-xyz.jpg" });
  assert.equal((await adminCatalog(req("/admin/catalog", "PUT", { catalog: c }, auth()))).status, 200);
  catalog = c;
});
await test("catégories : photo au chemin piégé refusée", async () => {
  const c = structuredClone(catalog);
  c.categories[0].image = "../secret.jpg";
  assert.equal((await adminCatalog(req("/admin/catalog", "PUT", { catalog: c }, auth()))).status, 400);
});
await test("catégories : suppression d'une catégorie encore utilisée refusée", async () => {
  const c = structuredClone(catalog);
  c.categories = c.categories.filter((x) => x.slug !== "polos");
  const r = await adminCatalog(req("/admin/catalog", "PUT", { catalog: c }, auth()));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Catégorie inconnue/);
});

console.log("Publication groupée");
const publishFn = (await import("../netlify/functions/admin-publish.mjs")).default;
await test("les enregistrements de l'admin sont mis en attente, sans publier", async () => {
  const d = await (await publishFn(req("/admin/publish", "GET", undefined, auth()))).json();
  assert.ok(d.pending.length >= 2, JSON.stringify(d.pending));
  assert.ok(d.pending.some((p) => p.what === "Réglages"));
});
await test("publier sans lien de build configuré → message clair", async () => {
  const r = await publishFn(req("/admin/publish", "POST", undefined, auth()));
  assert.equal(r.status, 503);
});
await test("publier → un seul appel au lien de build, puis plus rien en attente", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (String(url).startsWith("https://hook.test")) { calls++; return new Response("ok"); } return realFetch(url, opts); };
  process.env.BUILD_HOOK_URL = "https://hook.test/abc";
  try {
    const d = await (await publishFn(req("/admin/publish", "POST", undefined, auth()))).json();
    assert.equal(calls, 1);
    assert.equal(d.pending.length, 0);
    assert.ok(d.lastPublished);
  } finally { globalThis.fetch = realFetch; delete process.env.BUILD_HOOK_URL; }
});

console.log("Codes promo");
const promoFn = (await import("../netlify/functions/promo.mjs")).default;
const adminPromos = (await import("../netlify/functions/admin-promos.mjs")).default;
const polo = (size = "M", qty = 1) => [{ slug: "polo-dune-du-pyla", color: "Marine", size, qty }];
await test("codes invalides refusés à l'enregistrement", async () => {
  for (const bad of [[{ code: "a", type: "percent", percent: 10 }], [{ code: "TEST", type: "percent", percent: 150 }], [{ code: "X-1", type: "amount", amount: 0 }], [{ code: "AB1", type: "percent", percent: 5 }, { code: "ab1", type: "percent", percent: 5 }]]) {
    assert.equal((await adminPromos(req("/admin/promos", "PUT", { promos: bad }, auth()))).status, 400, JSON.stringify(bad));
  }
});
await test("création de codes : -10 %, -20 €, livraison offerte, limité aux casquettes, expiré", async () => {
  const r = await adminPromos(req("/admin/promos", "PUT", { promos: [
    { code: "bienvenue10", type: "percent", percent: 10, active: true },
    { code: "MOINS20", type: "amount", amount: 2000, min_order: 10000, max_uses: 1, active: true },
    { code: "PORTOFFERT", type: "shipping", active: true },
    { code: "CASQUETTE", type: "percent", percent: 50, categories: ["casquettes-accessoires"], active: true },
    { code: "ETE2020", type: "percent", percent: 30, ends: "2020-08-31", active: true },
    { code: "PAUSE", type: "percent", percent: 30, active: false },
    { code: "GROSPANIER", type: "amount", amount: 3000, min_order: 20000, active: true },
  ] }, auth()));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).promos[0].code, "BIENVENUE10");
});
await test("panier : code valide (minuscules acceptées) → remise calculée par le serveur", async () => {
  const d = await (await promoFn(req("/promo", "POST", { code: " bienvenue10 ", items: polo() }))).json();
  assert.equal(d.discount, 1190);
});
await test("panier : codes expiré, inactif, inconnu, hors catégorie, sous le minimum → refusés", async () => {
  for (const [code, items, msg] of [["ETE2020", polo(), /expiré/], ["PAUSE", polo(), /existe pas/], ["NIMPORTE", polo(), /existe pas/], ["CASQUETTE", polo(), /aucun article/], ["GROSPANIER", polo(), /dès 200/]]) {
    const r = await promoFn(req("/promo", "POST", { code, items }));
    assert.equal(r.status, 400, code);
    assert.match((await r.json()).error, msg, code);
  }
});
await test("paiement : remise transmise à Stripe et seuil de livraison offerte après remise", async () => {
  const s = await buildSession({ items: polo("M", 1), zone: "metro", promo: "bienvenue10" }, "https://x.fr");
  assert.equal(s.discount, 1190);
  assert.equal(s.params.metadata.promo_code, "BIENVENUE10");
  // 119 € - 11,90 € = 107,10 € ≥ 90 € (seuil modifié plus haut) → livraison offerte
  assert.equal(s.params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
});
await test("paiement : code « livraison offerte » en DOM-TOM", async () => {
  const s = await buildSession({ items: polo("M", 1), zone: "domtom", promo: "PORTOFFERT" }, "https://x.fr");
  assert.equal(s.discount, 0);
  assert.equal(s.params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
  assert.match(s.params.shipping_options[0].shipping_rate_data.display_name, /PORTOFFERT/);
});
await test("paiement : code invalide → la commande est refusée avec le motif", async () => {
  const s = await buildSession({ items: polo(), zone: "metro", promo: "ETE2020" }, "https://x.fr");
  assert.match(s.error, /expiré/);
});
await test("paiement confirmé → utilisation comptée ; limite atteinte → code refusé", async () => {
  const { params } = await buildSession({ items: polo("S", 1), zone: "metro", promo: "MOINS20" }, "https://x.fr");
  assert.ok(params, "MOINS20 accepté (119 € ≥ 100 €)");
  const r = await webhookMod.default(signed({ type: "checkout.session.completed", data: { object: { id: "cs_promo_1", created: Math.floor(Date.now() / 1000), payment_status: "paid", amount_total: 9900, metadata: params.metadata, customer_details: { name: "A", email: "a@b.fr" } } } }));
  assert.equal(r.status, 200);
  const list = (await (await adminPromos(req("/admin/promos", "GET", undefined, auth()))).json()).promos;
  assert.equal(list.find((p) => p.code === "MOINS20").uses, 1);
  const again = await promoFn(req("/promo", "POST", { code: "MOINS20", items: polo() }));
  assert.match((await again.json()).error, /maximum/);
});
await test("l'admin ne peut pas trafiquer le compteur (sauf remise à zéro explicite)", async () => {
  const list = (await (await adminPromos(req("/admin/promos", "GET", undefined, auth()))).json()).promos;
  list.find((p) => p.code === "MOINS20").uses = 0;
  let saved = (await (await adminPromos(req("/admin/promos", "PUT", { promos: list }, auth()))).json()).promos;
  assert.equal(saved.find((p) => p.code === "MOINS20").uses, 1);
  saved.find((p) => p.code === "MOINS20").reset_uses = true;
  saved = (await (await adminPromos(req("/admin/promos", "PUT", { promos: saved }, auth()))).json()).promos;
  assert.equal(saved.find((p) => p.code === "MOINS20").uses, 0);
});

console.log("Suivi des commandes");
await test("commande : statut, numéro de suivi et note enregistrés", async () => {
  const r = await orders(req("/admin/orders", "PATCH", { id: "cs_promo_1", statut: "expediee", suivi: "6a 1234 5678 901", note: "Colis déposé" }, auth()));
  assert.equal(r.status, 200);
  const o = (await r.json()).order;
  assert.equal(o.statut, "expediee");
  assert.equal(o.suivi, "6A12345678901");
  assert.equal(o.promo, "MOINS20");
});
await test("commande : statut ou numéro de suivi invalide refusé", async () => {
  assert.equal((await orders(req("/admin/orders", "PATCH", { id: "cs_promo_1", statut: "volee" }, auth()))).status, 400);
  assert.equal((await orders(req("/admin/orders", "PATCH", { id: "cs_promo_1", suivi: "<script>" }, auth()))).status, 400);
  assert.equal((await orders(req("/admin/orders", "PATCH", { id: "inconnue", statut: "livree" }, auth()))).status, 404);
});

console.log("Avis clients");
const reviewFn = (await import("../netlify/functions/review.mjs")).default;
const adminReviews = (await import("../netlify/functions/admin-reviews.mjs")).default;
const { publicReviews, getReviews } = await import("../netlify/lib/reviews.mjs");
const ctx = (ip) => ({ ip });
const avis = (extra = {}) => ({ slug: "polo-dune-du-pyla", name: "Marc", rating: 5, text: "Superbe broderie, taille parfaite.", consent: "1", ...extra });
await test("avis incomplets refusés (note, texte, consentement, produit)", async () => {
  for (const bad of [avis({ rating: 0 }), avis({ text: "court" }), avis({ consent: "" }), avis({ slug: "inconnu" }), avis({ email: "pas-un-mail" })]) {
    assert.equal((await reviewFn(req("/reviews", "POST", bad), ctx("1.1.1.1"))).status, 400, JSON.stringify(bad));
  }
});
await test("robot (champ piège rempli) : ignoré sans erreur", async () => {
  const r = await reviewFn(req("/reviews", "POST", avis({ website: "http://spam" })), ctx("2.2.2.2"));
  assert.equal(r.status, 200);
  assert.equal((await getReviews()).length, 0);
});
await test("avis déposé → en attente ; « Achat vérifié » si l'e-mail a commandé ce produit", async () => {
  assert.equal((await reviewFn(req("/reviews", "POST", avis({ email: "A@B.FR" })), ctx("3.3.3.3"))).status, 200);
  assert.equal((await reviewFn(req("/reviews", "POST", avis({ name: "Julie", email: "autre@x.fr", rating: 4 })), ctx("3.3.3.3"))).status, 200);
  const list = await getReviews();
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.status === "pending"));
  assert.equal(list.find((r) => r.name === "Marc").verified, true, "a@b.fr a commandé le polo (commande cs_promo_1)");
  assert.equal(list.find((r) => r.name === "Julie").verified, false);
});
await test("anti-spam : plus de 3 avis par heure depuis la même adresse → refusé", async () => {
  await reviewFn(req("/reviews", "POST", avis()), ctx("3.3.3.3"));
  assert.equal((await reviewFn(req("/reviews", "POST", avis()), ctx("3.3.3.3"))).status, 429);
});
await test("modération : publication → mise en attente de publication ; l'e-mail n'est jamais public", async () => {
  const list = (await (await adminReviews(req("/admin/reviews", "GET", undefined, auth()))).json()).reviews;
  const marc = list.find((r) => r.name === "Marc" && r.email);
  const r = await adminReviews(req("/admin/reviews", "PATCH", { id: marc.id, status: "approved" }, auth()));
  assert.ok((await r.json()).publish.pending.some((p) => p.what === "Avis clients"));
  const pub = publicReviews(await getReviews());
  assert.equal(pub["polo-dune-du-pyla"].length, 1);
  assert.equal(pub["polo-dune-du-pyla"][0].verified, true);
  assert.equal(JSON.stringify(pub).includes("@"), false, "aucun e-mail dans les avis publiés");
});
await test("modération : suppression d'un avis", async () => {
  const list = (await (await adminReviews(req("/admin/reviews", "GET", undefined, auth()))).json()).reviews;
  const julie = list.find((r) => r.name === "Julie");
  assert.equal((await adminReviews(req("/admin/reviews", "DELETE", { id: julie.id }, auth()))).status, 200);
  assert.equal((await getReviews()).some((r) => r.name === "Julie"), false);
});

console.log("Journal");
await test("articles : adresse invalide ou en double refusée", async () => {
  const c = (await (await adminContent(req("/admin/content", "GET", undefined, auth()))).json()).content;
  const bad1 = structuredClone(c); bad1.journal[0].slug = "Mon Article !";
  const bad2 = structuredClone(c); bad2.journal[1].slug = bad2.journal[0].slug;
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: bad1 }, auth()))).status, 400);
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: bad2 }, auth()))).status, 400);
});
await test("articles : nouvel article long (plus de 5 000 caractères) accepté", async () => {
  const c = (await (await adminContent(req("/admin/content", "GET", undefined, auth()))).json()).content;
  c.journal.push({ slug: "que-faire-a-arcachon", title: "Que faire à Arcachon ?", date: "2026-10-01", excerpt: "Nos adresses.", image: { src: "", alt: "" }, published: true, body: "Texte. ".repeat(1200) });
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: c }, auth()))).status, 200);
});

console.log("Soldes & promotions");
const pricing = await import("../netlify/lib/pricing.mjs");
const adminSales = (await import("../netlify/functions/admin-sales.mjs")).default;
const { boundaryToday } = await import("../netlify/functions/sales-scheduler.mjs");
const miniCat = { categories: [{ slug: "polos" }], products: [{ slug: "polo", category: "polos", price: 11900 }] };
await test("prix de référence : prix le plus bas des 30 jours précédant la réduction", () => {
  const h = [{ price: 12900, from: "2026-08-01" }, { price: 11900, from: "2026-09-20" }];
  assert.equal(pricing.referencePrice(h, 11900, "2026-10-01"), 11900, "baisse à 119 € le 20/09 → référence 119 €");
  assert.equal(pricing.referencePrice(h, 11900, "2026-09-15"), 12900, "avant la baisse → référence 129 €");
  assert.equal(pricing.referencePrice([], 11900, "2026-10-01"), 11900, "sans historique → prix actuel");
});
await test("campagne -20 % : prix réduit, prix barré et pourcentage", () => {
  const camp = [{ id: "a", active: true, scope: "all", percent: 20, kind: "promotion", starts: "2026-10-01", ends: "2026-10-15" }];
  const offers = pricing.computeOffers(miniCat, camp, {}, "2026-09-27");
  const o = pricing.activeOffer(offers.polo, "2026-10-05");
  assert.deepEqual([o.price, o.ref, o.percent], [9520, 11900, 20]);
  assert.equal(pricing.activeOffer(offers.polo, "2026-09-30"), null, "pas encore commencée");
  assert.equal(pricing.activeOffer(offers.polo, "2026-10-16"), null, "terminée (fin incluse le 15)");
  assert.ok(pricing.activeOffer(offers.polo, "2026-10-15"), "le dernier jour est inclus");
});
await test("pas de fausse réduction : prix de référence inférieur → pas de prix barré", () => {
  // le prix normal était de 90 € dans les 30 jours → une « promo » à 95 € n'est pas une réduction
  const h = { polo: [{ price: 9000, from: "2026-09-01" }, { price: 11900, from: "2026-09-25" }] };
  const offers = pricing.computeOffers({ ...miniCat, products: [{ slug: "polo", category: "polos", price: 11900, sale: { price: 9500, starts: "2026-10-01", ends: "" } }] }, [], h);
  assert.equal(offers.polo[0].ref, null);
  assert.equal(offers.polo[0].percent, 0);
});
await test("meilleure réduction retenue, jamais de cumul (promo produit vs campagne)", () => {
  const cat = { ...miniCat, products: [{ slug: "polo", category: "polos", price: 11900, sale: { price: 9900 } }] };
  const offers = pricing.computeOffers(cat, [{ id: "b", active: true, scope: "categories", categories: ["polos"], percent: 30, kind: "soldes", starts: "2026-01-01", ends: "2026-12-31" }], {});
  assert.equal(pricing.effectivePrice(cat.products[0], offers, "2026-06-01").price, 8330);
});
await test("campagnes invalides refusées ; valides enregistrées et mises en attente de publication", async () => {
  for (const bad of [[{ name: "", percent: 10, kind: "promotion", scope: "all", starts: "2026-10-01", ends: "2026-10-02" }], [{ name: "X", percent: 95, kind: "promotion", scope: "all", starts: "2026-10-01", ends: "2026-10-02" }], [{ name: "X", percent: 10, kind: "promotion", scope: "categories", categories: [], starts: "2026-10-01", ends: "2026-10-02" }], [{ name: "X", percent: 10, kind: "promotion", scope: "all", starts: "2026-10-05", ends: "2026-10-02" }]]) {
    assert.equal((await adminSales(req("/admin/sales", "PUT", { campaigns: bad }, auth()))).status, 400, JSON.stringify(bad));
  }
  const today = pricing.parisDate();
  const r = await adminSales(req("/admin/sales", "PUT", { campaigns: [{ name: "Promo polos", kind: "promotion", percent: 20, scope: "categories", categories: ["polos"], starts: today, ends: "2099-12-31", banner: "-20 % sur les polos", active: true }] }, auth()));
  assert.equal(r.status, 200);
  assert.ok((await r.json()).publish.pending.some((p) => p.what === "Soldes & promotions"));
});
await test("paiement : le prix soldé est facturé ; un code « hors promotions » ne s'y applique pas", async () => {
  const s = await buildSession({ items: polo("S", 1), zone: "metro" }, "https://x.fr");
  assert.equal(s.params.line_items[0].price_data.unit_amount, 9520);
  assert.match(s.params.line_items[0].price_data.product_data.name, /-20 %/);
  const list = (await (await adminPromos(req("/admin/promos", "GET", undefined, auth()))).json()).promos;
  list.push({ code: "HORSPROMO", type: "percent", percent: 10, exclude_sale: true, active: true });
  await adminPromos(req("/admin/promos", "PUT", { promos: list }, auth()));
  const res = await promoFn(req("/promo", "POST", { code: "HORSPROMO", items: polo("S", 1) }));
  assert.match((await res.json()).error, /déjà en promotion/);
});
await test("tâche planifiée : mise à jour du site seulement le jour d'un début ou le lendemain d'une fin", () => {
  const offers = { polo: [{ starts: "2026-10-01", ends: "2026-10-15" }] };
  assert.equal(boundaryToday(offers, "2026-10-01"), true);
  assert.equal(boundaryToday(offers, "2026-10-16"), true);
  assert.equal(boundaryToday(offers, "2026-10-10"), false);
});
await test("dates officielles des soldes 2027 (2e mercredi de janvier, dernier mercredi de juin)", () => {
  const [hiver, ete] = pricing.officialSalesPeriods(2027);
  assert.equal(hiver.starts, "2027-01-13");
  assert.equal(ete.starts, "2027-06-30");
});

console.log("Emballage cadeau & produits associés");
await test("emballage cadeau offert : message transmis à la commande, pas de ligne payante", async () => {
  const s = await buildSession({ items: polo("S", 1), zone: "metro", gift: { on: true, message: "  Joyeux   anniversaire !  " } }, "https://x.fr");
  assert.equal(s.params.metadata.cadeau, "oui");
  assert.equal(s.params.metadata.message_cadeau, "Joyeux anniversaire !");
  assert.equal(s.params.line_items.some((l) => l.price_data.product_data.name === "Emballage cadeau"), false);
});
await test("emballage cadeau payant (3 €) : ligne ajoutée au paiement ; désactivé : ignoré", async () => {
  await adminContent(req("/admin/content", "PUT", { settings: { gift: { enabled: true, price: 300, description: "Paquet cadeau" } } }, auth()));
  let s = await buildSession({ items: polo("S", 1), zone: "metro", gift: { on: true } }, "https://x.fr");
  assert.equal(s.params.line_items.find((l) => l.price_data.product_data.name === "Emballage cadeau").price_data.unit_amount, 300);
  await adminContent(req("/admin/content", "PUT", { settings: { gift: { enabled: false, price: 300, description: "" } } }, auth()));
  s = await buildSession({ items: polo("S", 1), zone: "metro", gift: { on: true } }, "https://x.fr");
  assert.equal(s.params.metadata.cadeau, undefined);
});
await test("emballage cadeau : prix invalide refusé", async () => {
  assert.equal((await adminContent(req("/admin/content", "PUT", { settings: { gift: { enabled: true, price: -5 } } }, auth()))).status, 400);
});
await test("commande payée avec cadeau → option et message visibles dans l'admin", async () => {
  await adminContent(req("/admin/content", "PUT", { settings: { gift: { enabled: true, price: 0, description: "Paquet cadeau" } } }, auth()));
  const { params } = await buildSession({ items: polo("S", 1), zone: "retrait", gift: { on: true, message: "Bonne fête Papa" } }, "https://x.fr");
  await webhookMod.default(signed({ type: "checkout.session.completed", data: { object: { id: "cs_gift_1", created: Math.floor(Date.now() / 1000), payment_status: "paid", amount_total: 9520, metadata: params.metadata, customer_details: { name: "B", email: "b@c.fr" } } } }));
  const o = (await (await orders(req("/admin/orders", "GET", undefined, auth()))).json()).orders.find((x) => x.id === "cs_gift_1");
  assert.equal(o.cadeau, true);
  assert.equal(o.messageCadeau, "Bonne fête Papa");
});
await test("produits associés : liste invalide refusée, valide acceptée", async () => {
  const c = (await (await adminCatalog(req("/admin/catalog", "GET", undefined, auth()))).json()).catalog;
  const bad = structuredClone(c); bad.products[0].related = ["../x"];
  assert.equal((await adminCatalog(req("/admin/catalog", "PUT", { catalog: bad }, auth()))).status, 400);
  const good = structuredClone(c); good.products[0].related = ["casquette-bassin-arcachon"];
  assert.equal((await adminCatalog(req("/admin/catalog", "PUT", { catalog: good }, auth()))).status, 200);
});

console.log("Compatibilité des anciens contenus");
await test("contenu enregistré avant l'ajout de la FAQ et du Journal → complété, jamais perdu", async () => {
  const { store } = await import("../netlify/lib/store.mjs");
  const old = structuredClone(content);
  delete old.faq; delete old.journal; delete old.journal_intro;
  old.home.hero.title = "Titre saisi dans l'admin";
  await (await store("site")).setJSON("content", old);
  const d = await (await adminContent(req("/admin/content", "GET", undefined, auth()))).json();
  assert.ok(d.content.faq.sections.length > 0, "FAQ reprise du projet");
  assert.ok(d.content.journal.length > 0, "articles du Journal repris du projet");
  assert.equal(d.content.home.hero.title, "Titre saisi dans l'admin", "la saisie de l'admin reste prioritaire");
  assert.equal((await adminContent(req("/admin/content", "PUT", { content: d.content }, auth()))).status, 200, "l'enregistrement fonctionne de nouveau");
});

console.log("Suppression");
await test("produit supprimé → son stock aussi", async () => {
  const c = structuredClone(catalog);
  c.products = c.products.filter((p) => p.slug !== "bob-bassin");
  await adminCatalog(req("/admin/catalog", "PUT", { catalog: c }, auth()));
  const d = await (await stockFn(req("/stock"))).json();
  assert.equal(d.stock["bob-bassin"], undefined);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} tests réussis${process.exitCode ? ", des erreurs sont survenues" : ""}.`);
