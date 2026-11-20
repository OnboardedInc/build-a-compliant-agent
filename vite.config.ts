import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "path";
import { basePath, withBase } from "./src/shared/base-path.ts";

const base = basePath(process.env.BCA_BASE_PATH);
const publicDir = path.resolve(import.meta.dirname, "public");

export default defineConfig({
  plugins: [react(), tailwindcss(), base ? {
    name: "coming-soon",
    apply: "build",
    buildStart() {
      // Vite only empties the nested outDir in this mode.
      rmSync(publicDir, { recursive: true, force: true });
    },
    writeBundle() {
      const html = readFileSync(path.resolve(import.meta.dirname, "src/coming-soon/index.html"), "utf8");
      writeFileSync(path.join(publicDir, "index.html"), html.replace('href="/hiring-agent/"', `href="${withBase(base, "/")}"`));
    },
  } : null],
  base: withBase(base, "/"),
  root: "src/app",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/app"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  build: {
    outDir: `../../public${base}`,
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
