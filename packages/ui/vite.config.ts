import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@sous-chef/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true, target: "es2022" },
});
