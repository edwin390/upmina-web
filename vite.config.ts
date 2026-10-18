import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
// Funciones dependientes de Mina (Instagram, TikTok, Cosplays): lista de MINA_FEATURES_ENABLED en la compilación; solo presentación.
// El servidor la vuelve a comprobar en cada endpoint. En pruebas se activan todas para no alterar las suites existentes.
export default defineConfig(({ mode }) => ({
  define: {
    __MINA_FEATURES__: JSON.stringify(
      mode === "test"
        ? "instagram,tiktok,cosplay"
        : (process.env.MINA_FEATURES_ENABLED ??
            loadEnv(mode, process.cwd(), "").MINA_FEATURES_ENABLED ??
            ""),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    exclude: ["e2e/**", "node_modules/**"],
    // R5-I: tope de workers (PGlite + muchos workers => "Worker exited unexpectedly").
    poolOptions: { forks: { minForks: 1, maxForks: 6 } },
  },
}));
