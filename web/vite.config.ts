import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The web app is the True ROAS "AI Studio" module: Toast dashboard, review
 * queue and agent recommendations. In production it reads Supabase; here it
 * reads the JSON the demo CLI writes to ../out, served as static files.
 */
export default defineConfig({
  root: here,
  publicDir: resolve(here, "../out"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@src": resolve(here, "../src") } },
  server: { port: 5173, strictPort: true },
  // One bundle is fine for an internal tool behind login; Recharts and React account for most of it.
  build: { outDir: resolve(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
