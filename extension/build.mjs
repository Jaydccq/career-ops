/**
 * build.mjs — esbuild entrypoint for the career-ops Chrome extension.
 *
 * Bundles three entry points into dist/:
 *   • background.js  (service worker)
 *   • popup.js       (popup controller)
 *   • content.js     (unused at runtime; see note below)
 *
 * Copies:
 *   • public/manifest.json  → dist/manifest.json
 *   • public/popup.html     → dist/popup.html
 *   • public/popup.css      → dist/popup.css
 *
 * Note on content.js: the popup uses chrome.scripting.executeScript with
 * the `func` field to inject `capturePage` directly from the background
 * bundle. esbuild bundles the function via the background entry, so we
 * do NOT register a persistent content script in the manifest.
 */

import { build } from "esbuild";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "src");
const PUBLIC_DIR = join(__dirname, "public");
const DIST = join(__dirname, "dist");

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await build({
    entryPoints: {
      background: join(SRC, "background/index.ts"),
      popup: join(SRC, "popup/index.ts"),
    },
    bundle: true,
    format: "esm",
    target: "es2022",
    outdir: DIST,
    sourcemap: "linked",
    minify: false,
    logLevel: "info",
  });

  // Copy static assets
  await copyFile(join(PUBLIC_DIR, "manifest.json"), join(DIST, "manifest.json"));
  await copyFile(join(PUBLIC_DIR, "popup.html"), join(DIST, "popup.html"));
  await copyFile(join(PUBLIC_DIR, "popup.css"), join(DIST, "popup.css"));

  console.log("\n✅ extension built → dist/");
  console.log("   Load in Chrome: chrome://extensions → 'Load unpacked' → select dist/");
}

main().catch((err) => {
  console.error("build failed:", err);
  process.exit(1);
});
