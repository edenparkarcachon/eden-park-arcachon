// Serveur de développement local : reproduit Netlify (site statique + fonctions /api/*)
// avec un stockage dans le dossier .local-store/.
//
//   node scripts/dev-server.mjs            → http://localhost:8888
//   Mot de passe admin local : variable ADMIN_PASSWORD (par défaut « admin-local »)
//
// Sans clé Stripe, un paiement est simulé : la commande est enregistrée et le stock
// décompté comme après un vrai paiement.

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.PORT || 8888);
process.env.LOCAL_STORE_DIR ||= path.join(ROOT, ".local-store");
process.env.ADMIN_PASSWORD ||= "admin-local";
process.env.SITE_URL ||= `http://localhost:${PORT}`;
process.env.BUILD_HOOK_URL ||= `http://localhost:${PORT}/__dev/rebuild`;

function rebuild() {
  execSync(`"${process.execPath}" scripts/sync-catalog.mjs && ruby build.rb`, { cwd: ROOT, stdio: "inherit", env: process.env });
}

const { store } = await import("../netlify/lib/store.mjs");
const { applyOrder } = await import("../netlify/functions/stripe-webhook.mjs");
const { buildSession } = await import("../netlify/functions/checkout.mjs");

// Charge les fonctions et leurs routes (config.path)
const routes = [];
for (const f of (await fs.readdir(path.join(ROOT, "netlify/functions"))).filter((n) => n.endsWith(".mjs"))) {
  const mod = await import(pathToFileURL(path.join(ROOT, "netlify/functions", f)).href);
  const p = mod.config?.path || `/.netlify/functions/${f.replace(/\.mjs$/, "")}`;
  const names = [];
  const re = new RegExp("^" + p.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
  routes.push({ re, names, handler: mod.default, name: f });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };

async function serveStatic(pathname, res) {
  const dist = path.join(ROOT, "dist");
  let file = path.normalize(path.join(dist, decodeURIComponent(pathname)));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(data);
  } catch {
    // photos envoyées depuis l'admin mais pas encore intégrées par un build
    const m = pathname.match(/^\/assets\/img\/(?:produits\/)?uploads\/([a-z0-9-]+\.jpg)$/);
    if (m) {
      const data = await (await store("images")).get(m[1], { type: "arrayBuffer" });
      if (data) { res.writeHead(200, { "Content-Type": "image/jpeg" }).end(Buffer.from(data)); return; }
    }
    const notFound = await fs.readFile(path.join(dist, "404.html")).catch(() => "Introuvable");
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end(notFound);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/__dev/rebuild") {
      rebuild();
      res.writeHead(200).end("ok");
      return;
    }
    // Paiement simulé en local (aucune clé Stripe) : enregistre la commande et décompte le stock
    if (url.pathname === "/api/checkout" && req.method === "POST" && !process.env.STRIPE_SECRET_KEY) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { params, error, discount } = await buildSession(JSON.parse(Buffer.concat(chunks).toString() || "{}"), process.env.SITE_URL);
      if (error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error })); return; }
      const total = params.line_items.reduce((s, l) => s + l.price_data.unit_amount * l.quantity, 0) + params.shipping_options[0].shipping_rate_data.fixed_amount.amount - (discount || 0);
      await applyOrder({
        id: `cs_local_${Date.now()}`, created: Math.floor(Date.now() / 1000), amount_total: total, payment_status: "paid", metadata: params.metadata,
        customer_details: { name: "Client test (local)", email: "test@example.com", phone: "+33600000000" },
        shipping_details: { name: "Client test", address: { line1: "1 rue du Test", postal_code: "33120", city: "Arcachon", country: "FR" } },
      });
      console.log(`Commande simulée (${params.metadata.sur_commande === "oui" ? "sur commande" : "en stock"}) : ${params.shipping_options[0].shipping_rate_data.display_name}`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ url: "/merci/?demo=1" }));
      return;
    }
    for (const r of routes) {
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const response = await r.handler(request, { params });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Erreur serveur : " + e.message);
  }
});

if (!process.argv.includes("--no-build")) rebuild();
server.listen(PORT, () => {
  console.log(`\nEden Park Arcachon – serveur local : http://localhost:${PORT}`);
  console.log(`Administration : http://localhost:${PORT}/admin/  (mot de passe : ${process.env.ADMIN_PASSWORD})`);
});
