import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { main: "index.html", howItWorks: "how-it-works.html", commandLine: "command-line.html" } },
  },
});
