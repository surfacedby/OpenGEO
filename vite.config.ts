import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import identity from "./brand/identity.json";
export default defineConfig({
  plugins: [react(), tailwind(), { name: "product-identity", transformIndexHtml: (html) => html.replace(/<title>.*?<\/title>/, "<title>" + identity.name + "</title>") }],
  server: {
    port: 4317,
    proxy: { "/api": { target: "http://127.0.0.1:4318", changeOrigin: false } },
  },
  build: { sourcemap: false },
});
