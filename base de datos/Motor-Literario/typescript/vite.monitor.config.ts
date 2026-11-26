import { defineConfig } from "vite";

/**
 * Bundle exclusivo para probar el monitor cuando el entrypoint general
 * contiene errores en módulos que no participan en la observabilidad.
 */
export default defineConfig({
  build: {
    target: "es2022",
    lib: {
      entry: "src/live-author-monitor-test-entry.ts",
      formats: ["es"],
      fileName: "live-author-monitor"
    },
    outDir: "dist-monitor",
    emptyOutDir: true,
    sourcemap: true
  }
});
