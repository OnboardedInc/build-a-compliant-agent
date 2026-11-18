import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/app",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/app"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: "../../public",
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
