import { defineConfig } from "vite";

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
