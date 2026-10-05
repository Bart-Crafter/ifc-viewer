import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web");

export default defineConfig({
  root: webRoot,
  build: {
    outDir: path.join(webRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(webRoot, "index.html"),
        model: path.join(webRoot, "model.html"),
      },
    },
  },
});
