#!/usr/bin/env node
/**
 * `npm test` entry point. Two tiers:
 *
 *   1. Unit tests (src/*.test.js, via node:test) -- fast, exercise one
 *      module directly through a real `import`, no file to decode.
 *   2. The integration suite (tools/check*.mjs) -- exercises the built
 *      index.html end to end against real parquet fixtures and duckdb.
 *      Needs a fixture directory (python3 tools/fixtures.py <dir>); if one
 *      isn't given and none is found, this tier is skipped with a clear
 *      note rather than failing, since pyarrow isn't always installed.
 *
 * Usage: node tools/run-tests.mjs [fixtureDir]   (default: /tmp/fx)
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = process.argv[2] || "/tmp/fx";

function run(label, cmd, args) {
  console.log(`\n→ ${label}`);
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`✗ ${label} failed`);
    return false;
  }
  return true;
}

let ok = true;

const unitFiles = globSync("src/*.test.js", { cwd: root });
if (unitFiles.length) {
  ok = run("unit tests", process.execPath, ["--test", ...unitFiles]) && ok;
} else {
  console.log("→ unit tests: none found under src/*.test.js");
}

if (existsSync(fixtureDir)) {
  const parquetFiles = globSync("*.parquet", { cwd: fixtureDir }).map((f) => path.join(fixtureDir, f));
  if (parquetFiles.length) {
    ok = run("decode correctness (check.mjs)", process.execPath, ["tools/check.mjs", ...parquetFiles]) && ok;
    ok = run("SQL round-trip + refusals (check-sql.mjs)", process.execPath, ["tools/check-sql.mjs", parquetFiles[0]]) && ok;
  }
  const pushDir = path.join(fixtureDir, "push");
  if (existsSync(pushDir)) {
    ok = run("pushdown equivalence (check-push.mjs)", process.execPath, ["tools/check-push.mjs", pushDir]) && ok;
  }
  const diffDir = path.join(fixtureDir, "diff");
  if (existsSync(diffDir) && parquetFiles.length) {
    ok = run("diff correctness (check-diff.mjs)", process.execPath, ["tools/check-diff.mjs", diffDir, ...parquetFiles]) && ok;
  }
  const foldersDir = path.join(fixtureDir, "folders");
  if (existsSync(foldersDir)) {
    ok = run("partitioned folders (check-folder.mjs)", process.execPath, ["tools/check-folder.mjs", foldersDir]) && ok;
  }
} else {
  console.log(`\n→ integration suite: skipped, no fixture directory at ${fixtureDir}`);
  console.log(`  generate one with: python3 tools/fixtures.py ${fixtureDir}`);
  console.log(`  then: node tools/run-tests.mjs ${fixtureDir}`);
}

console.log(ok ? "\nAll tests passed." : "\nSome tests failed.");
process.exit(ok ? 0 : 1);
