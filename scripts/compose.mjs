#!/usr/bin/env node
/**
 * Assembles src/*.js into the single index.html the project ships.
 *
 * This is a strip-and-concatenate, not a bundler: modules use real
 * import/export so Biome and editors can check each one's dependencies in
 * isolation, but at build time those statements are just deleted and the
 * module bodies are concatenated, in the fixed order below, into one
 * script sharing one global scope -- the same shape the file has always
 * shipped in. The manifest order is load-bearing: it must be a valid
 * dependency order (a module's own top-level code can only rely on
 * something from a module that comes before it), since nothing here
 * resolves imports the way a real bundler would.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const srcDir = path.join(root, "src");

const MANIFEST = [
  "bytes", "thrift", "codecs", "encoding", "types", "dataset", "workers",
  "columns", "view", "ui-grid", "ui-metadata", "query", "ui-query-builder",
  "pushdown", "diff", "main", "ui-tree",
];

const IMPORT_RE = /^import\s*\{[^}]*\}\s*from\s*"\.\/[\w-]+\.js";\n?/gm;
const EXPORT_RE = /^export\s+(?=(?:async\s+function|function|class|const|let)\b)/gm;

function stripModule(text) {
  return text.replace(IMPORT_RE, "").replace(EXPORT_RE, "").replace(/^\n+/, "");
}

function compose() {
  const bodies = MANIFEST.map((name) => {
    const file = path.join(srcDir, `${name}.js`);
    const raw = readFileSync(file, "utf-8");
    return stripModule(raw).replace(/\n+$/, "");
  });
  const script = '"use strict";\n\n' + bodies.join("\n\n") + "\n";
  const template = readFileSync(path.join(srcDir, "index.template.html"), "utf-8");
  if (!template.includes("{{SCRIPT}}")) {
    throw new Error("src/index.template.html is missing the {{SCRIPT}} placeholder");
  }
  const notice = "<!-- GENERATED FILE. Edit src/*.js and src/index.template.html, " +
    "then run scripts/compose.sh (or npm run build) -- do not hand-edit this file. -->\n";
  const filled = template.replace("{{SCRIPT}}", () => script);
  // the notice goes right after <!doctype html>, never before it: a leading
  // comment ahead of the doctype risks quirks mode in some browsers
  const out = filled.replace(/^(<!doctype html>\n)/i, `$1${notice}`);
  writeFileSync(path.join(root, "index.html"), out);
  return { modules: MANIFEST.length, bytes: out.length };
}

const result = compose();
console.log(`built index.html from ${result.modules} modules (${result.bytes} bytes)`);
