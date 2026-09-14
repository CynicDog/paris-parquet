/**
 * Drives index.html in a real browser: loads a parquet file through the same
 * File input a user would use, then reports what the page actually rendered.
 *
 *   node tools/browser.mjs file.parquet [--shot out.png] [--wide]
 */
import path from "node:path";
import { createRequire } from "node:module";

/* createRequire honours NODE_PATH, so a global playwright install works */
const { chromium } = createRequire(import.meta.url)("playwright");

const args = process.argv.slice(2);
const shotAt = args.indexOf("--shot");
const shot = shotAt >= 0 ? args[shotAt + 1] : null;
const files = args.filter((a, i) => !a.startsWith("--") && i !== shotAt + 1);
const wide = args.includes("--wide");
const here = path.dirname(new URL(import.meta.url).pathname);
const appPath = path.join(here, "..", "index.html");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: wide ? 1600 : 1280, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.type() + ": " + m.text()); });
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

let failed = 0;
for (const file of files) {
  await page.goto("file://" + appPath);
  const t0 = Date.now();
  await page.setInputFiles("#picker", file);
  await page.waitForFunction(() => document.getElementById("busy").hidden, null, { timeout: 120000 });
  const ms = Date.now() - t0;
  const report = await page.evaluate(() => {
    const err = document.getElementById("err");
    const grid = document.getElementById("grid");
    const cells = [...grid.querySelectorAll("tbody tr")].slice(0, 3)
      .map((tr) => [...tr.children].map((td) => td.textContent).join(" | "));
    return {
      error: err ? err.textContent : null,
      fileline: document.getElementById("fileline").textContent,
      bar: document.getElementById("mbar").textContent.replace(/\s+/g, " ").trim(),
      headers: [...grid.querySelectorAll("tr.r-name th")].map((th) => th.textContent),
      summaries: [...grid.querySelectorAll("tr.r-sum th")].map((th) => th.textContent.replace(/\s+/g, " ").trim()),
      rows: document.querySelectorAll("#tbody tr").length,
      sample: cells,
      gridWidth: grid.scrollWidth,
      metaCards: document.querySelectorAll("#mbody .mcard").length,
    };
  });
  const name = path.basename(file);
  if (report.error) {
    console.log(`FAIL ${name}: ${report.error}`);
    failed++;
  } else {
    console.log(`ok   ${name}  ${ms} ms`);
    console.log(`     ${report.fileline}`);
    console.log(`     ${report.bar}`);
    console.log(`     columns: ${report.headers.slice(1, 5).map((h) => JSON.stringify(h)).join(" ")}${report.headers.length > 5 ? " ..." : ""}`);
    console.log(`     summary[1]: ${report.summaries[1]}`);
    console.log(`     summary[2]: ${report.summaries[2]}`);
    for (const r of report.sample) console.log(`     row: ${r.slice(0, 150)}`);
    console.log(`     ${report.metaCards} metadata cards, ${report.rows} rendered rows`);
  }
  if (shot) {
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`     screenshot -> ${shot}`);
  }
}
if (logs.length) {
  console.log("\nconsole output:");
  for (const l of logs) console.log("  " + l);
}
await browser.close();
process.exit(failed || logs.some((l) => l.startsWith("pageerror")) ? 1 : 0);
