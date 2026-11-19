import { defineConfig } from "vite";
import { siteProfile } from "./tools/site-profile.mjs";

export default defineConfig({
  plugins: [siteProfile()],
  build: {
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { main: "index.html", howItWorks: "how-it-works.html", commandLine: "command-line.html", privacy: "privacy.html", notFound: "404.html" } },
  },
});
