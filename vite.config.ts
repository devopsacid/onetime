import { defineConfig } from "vite";
import { siteProfile } from "./tools/site-profile.mjs";

export default defineConfig({
  plugins: [siteProfile()],
  build: {
    emptyOutDir: true,
    sourcemap: false,
  },
});
