#!/usr/bin/env node
/**
 * Writes index.min.html: the same single self-contained page with its script minified (terser), for saving or
 * mailing. It is opt-in and generated on demand, never committed: index.html stays the readable file that ships
 * and that every test exercises. Minifying changes legibility only: still one file, still no request.
 *
 * Deliberately not obfuscated: that made the output larger, cannot hide code from a determined reader, and
 * would defeat the point of a page whose pitch is "open it, read it, nothing leaves your machine".
 *
 *   npm run build:min        (after npm run build)
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "index.html"), out = path.join(root, "index.min.html");
const html = readFileSync(src, "utf8");
const open = html.lastIndexOf("<script>"), close = html.lastIndexOf("</script>");
if (open < 0 || close < open) { console.error("no inline <script> in index.html; run npm run build first"); process.exit(1); }
const code = html.slice(open + "<script>".length, close);
const result = await minify(code, {
  /* conservative: keep function and class names (the page reports errors by name and uses a few deliberate idioms) */
  compress: { passes: 2, keep_fnames: true, keep_classnames: true },
  mangle: { keep_fnames: true, keep_classnames: true },
  format: { comments: false },
});
if (result.error) { console.error(result.error); process.exit(1); }
writeFileSync(out, html.slice(0, open + "<script>".length) + result.code + html.slice(close));
const a = statSync(src).size, b = statSync(out).size;
console.log("index.min.html: " + Math.round(b / 1024) + " KB from " + Math.round(a / 1024) + " KB (" + Math.round((1 - b / a) * 100) + "% smaller)");
