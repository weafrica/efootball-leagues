// Vite plugin: builds Ludo's service worker (dist/ludo/sw.js).
//
// A service worker can't know the hashed filenames Vite gives the JS/CSS
// chunks (Ludo-Ab12Cd.js ...), so a hand-written static file can't precache
// them. This plugin runs after the bundle is built, works out exactly which
// files the Ludo entry page needs — its own chunks, the ones they import, and
// the lazy-loaded game chunk — and bakes that list into src/ludo/sw.template.js.
//
// It deliberately collects ONLY what's reachable from ludo/index.html, so
// Matchday's own chunks (the 15,000-line App, chess, planet earth, ...) are
// never dragged into Ludo's offline cache.
//
// The worker's version is a hash of that list + the entry HTML + the manifest,
// so its bytes only change when Ludo actually changed. A deploy that only
// touched Matchday leaves Ludo's worker byte-identical and players aren't
// made to re-download anything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, "../src/ludo/sw.template.js");
const HTML_ENTRY = "ludo/index.html";

export default function ludoPwa() {
  let publicDir = "";

  return {
    name: "ludo-pwa",
    apply: "build",
    // Must run AFTER Vite's own HTML plugin: the entry page (and the final
    // hashed asset names inside it) don't exist in the bundle until then.
    enforce: "post",

    configResolved(config) {
      publicDir = config.publicDir;
    },

    generateBundle: { order: "post", handler(_options, bundle) {
      const html = bundle[HTML_ENTRY];
      if (!html) {
        this.warn(`[ludo-pwa] ${HTML_ENTRY} not in the bundle — no service worker emitted.`);
        return;
      }
      const htmlSource = String(html.source);

      // Everything the HTML references directly (entry script, modulepreloads, CSS).
      const roots = [...htmlSource.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);

      // Walk the import graph from those roots: static imports, lazy
      // (dynamic) imports and the CSS each chunk pulls in.
      const files = new Set();
      const visit = (name) => {
        if (files.has(name)) return;
        const item = bundle[name];
        if (!item) return;
        files.add(name);
        if (item.type === "chunk") {
          item.imports.forEach(visit);
          item.dynamicImports.forEach(visit);
          (item.viteMetadata?.importedCss || []).forEach(visit);
          (item.viteMetadata?.importedAssets || []).forEach(visit);
        }
      };
      roots.forEach(visit);

      const precache = [
        "/ludo/",
        "/ludo/manifest.webmanifest",
        "/ludo/icons/icon-192.png",
        ...[...files].sort().map((f) => "/" + f),
      ];

      let manifestText = "";
      try { manifestText = fs.readFileSync(path.join(publicDir, "ludo/manifest.webmanifest"), "utf8"); } catch { /* optional */ }
      const version = crypto.createHash("sha1")
        .update(JSON.stringify(precache)).update(htmlSource).update(manifestText)
        .digest("hex").slice(0, 10);

      const source = fs.readFileSync(TEMPLATE, "utf8")
        .replace("__LUDO_VERSION__", version)
        .replace("__LUDO_PRECACHE__", JSON.stringify(precache, null, 2));

      this.emitFile({ type: "asset", fileName: "ludo/sw.js", source });

      const bytes = [...files].reduce((n, f) => {
        const it = bundle[f];
        return n + (it.type === "chunk" ? it.code.length : String(it.source).length);
      }, 0);
      this.info?.(`[ludo-pwa] service worker v${version}: precaching ${precache.length} files (~${Math.round(bytes / 1024)} KB of code)`);
    } },
  };
}
