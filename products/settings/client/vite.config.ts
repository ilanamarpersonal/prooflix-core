import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // served under /settings/; the portal is at /
  base: "/settings/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5176,
    // Forward API calls to the Python server during development.
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
})
