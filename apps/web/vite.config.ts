import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(directory, "dist/client"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      "/trpc": {
        target: process.env.AGENT_MULTIPLEX_WEB_GATEWAY ?? "http://127.0.0.1:4318",
        ws: true,
      },
    },
  },
});
