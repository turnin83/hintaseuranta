import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../supabase/functions/_shared", import.meta.url)) },
  },
  server: { fs: { allow: [".."] } },
  build: { target: "es2022" },
});
