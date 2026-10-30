import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import ludoPwa from "./scripts/vite-plugin-ludo-pwa.js";

// Three HTML entries, built together so they share the Supabase client and the
// common vendor chunks, but each loading only what it uses:
//   index.html       -> the main Matchday app, served at /
//   shop-app/...     -> the standalone, separately-installable shop app,
//                       served at /shop-app/ (see vercel.json)
//   ludo/index.html  -> Ludo, its own installable app with its own homepage and
//                       sign-in, served at /ludo/. The ludoPwa plugin generates
//                       its offline service worker (dist/ludo/sw.js) at build time.
export default defineConfig({
  plugins: [react(), ludoPwa()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        shop: resolve(__dirname, "shop-app/index.html"),
        ludo: resolve(__dirname, "ludo/index.html"),
      },
    },
  },
});
