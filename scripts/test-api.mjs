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
