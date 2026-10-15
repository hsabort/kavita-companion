// Bundles web/main.js (with Uppy and its CSS) into public/build/app.js and app.css.
import { build } from "esbuild";

await build({
  entryPoints: { app: "web/main.js" },
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  outdir: "public/build",
  logLevel: "info",
});
