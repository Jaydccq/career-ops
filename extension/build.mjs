/**
 * build.mjs — esbuild entrypoint for the career-ops Chrome extension.
 *
 * Bundles three entry points into dist/:
 *   • background.js  (service worker, ESM)
 *   • popup.js       (popup controller, ESM)
 *   • content.js     (injected content script, IIFE — self-contained)
 *
 * Copies:
 *   • public/manifest.json  → dist/manifest.json
 *   • public/popup.html     → dist/popup.html
 *   • public/popup.css      → dist/popup.css
 *
 * content.js is bundled as IIFE (not ESM) because it runs via
 * chrome.scripting.executeScript({ files: ["content.js"] }) in the
 * page's isolated world. The IIFE's return value is the capture result.
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

  // Background + popup: ESM modules
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

  // Content script: IIFE (runs in page context, must be self-contained)
  await build({
    entryPoints: {
      content: join(SRC, "content/extract.ts"),
    },
    bundle: true,
    format: "iife",
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
