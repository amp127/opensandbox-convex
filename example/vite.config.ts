import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Reads CONVEX_URL and CONVEX_SITE_URL, which `npx convex dev` writes to the
// repo's .env.local. For a production build, set both in the environment.
export default defineConfig({
  root: import.meta.dirname,
  envDir: "..",
  envPrefix: ["VITE_", "CONVEX_URL", "CONVEX_SITE_URL"],
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
