/// <reference types="vitest/config" />
import path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The release the server runs: web is built from the same checkout, so the root package.json version is the server version.
const version = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string }).version;

export default defineConfig({
  define: { "import.meta.env.VITE_VERSION": JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { proxy: { "/api": "http://localhost:4747" } },
  test: { environment: "jsdom", setupFiles: "./src/test-setup.ts", include: ["src/**/*.test.tsx"], css: false },
});
