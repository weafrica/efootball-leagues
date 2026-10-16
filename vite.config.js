import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Two HTML entries: the main Matchday app (index.html) and the standalone,
// separately-installable shop app (shop-app/index.html -> served at
// /shop-app/, see vercel.json).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        shop: resolve(__dirname, "shop-app/index.html"),
      },
    },
  },
});
