import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The enterprise portal, served at / (each product under its own path, e.g. /ingestiq/).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5174,
    // Forward API calls to the Python server during development.
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
})
