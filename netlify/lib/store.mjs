// Accès au stockage : Netlify Blobs en production, dossier local en développement
// (variable LOCAL_STORE_DIR, utilisée par scripts/dev-server.mjs).

import { promises as fs } from "node:fs";
import path from "node:path";

function localStore(name) {
  const dir = path.join(process.env.LOCAL_STORE_DIR, name);
  const file = (key) => path.join(dir, encodeURIComponent(key));
  return {
    async get(key, opts = {}) {
      try {
        const buf = await fs.readFile(file(key));
        if (opts.type === "json") return JSON.parse(buf.toString("utf8"));
        if (opts.type === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return buf.toString("utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async set(key, data) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    },
    async setJSON(key, obj) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), JSON.stringify(obj));
    },
    async delete(key) {
      await fs.rm(file(key), { force: true });
    },
    async list({ prefix = "" } = {}) {
      let names = [];
      try { names = await fs.readdir(dir); } catch { /* vide */ }
      return { blobs: names.map(decodeURIComponent).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

export async function store(name) {
  if (process.env.LOCAL_STORE_DIR) return localStore(name);
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name, consistency: "strong" });
}
