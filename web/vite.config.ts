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
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    // Vendors change rarely and cache independently of the app; Recharts only matters on the Toast tab.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](recharts|d3-[a-z-]+|victory-vendor|react-smooth|recharts-scale)[\\/]/.test(id)) return "charts";
          if (id.includes("@tanstack")) return "query";
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          return "vendor";
        },
      },
    },
    // scripts/check-bundle.ts enforces the real budget (largest chunk and total) in `npm run verify`.
    chunkSizeWarningLimit: 500,
  },
});
