// How the stress harness measures a browser's memory, per platform, and what it refuses to measure.
//
// The measure has to see memory the OS has compressed or swapped: under pressure a renderer's resident
// size drops while what it holds does not, and a limit built on resident size never fires (an earlier
// version of the harness read a renderer at 13 GB as 2 GB; docs/stress-test.md). So each platform uses
// its own "what this process really holds":
//
//   macOS    `footprint`: physical footprint, including compressed and swapped pages.
//   Linux    /proc/<pid>/smaps_rollup: Pss (proportional resident) plus Swap.
//   Windows  PrivateMemorySize64: private committed bytes, resident or paged out.
//
// Where none of these is available the harness stops rather than fall back to resident size, unless
// asked to with --allow-rss (and it then says the numbers are not to be trusted under pressure).
//
// The macOS and Linux paths are exercised (Linux in CI); the Windows path is written from the documented
// behaviour of the commands and has not been run on Windows.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PS = "powershell -NoProfile -NonInteractive -Command ";

/** Every process as { pid, ppid, cmd }. */
function processes() {
  if (process.platform === "win32") {
    const out = execSync(PS + JSON.stringify("Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"), { maxBuffer: 1 << 26 }).toString();
    return out.split(/\r?\n/).map((l) => { const i = l.indexOf("|"), j = l.indexOf("|", i + 1); return { pid: +l.slice(0, i), ppid: +l.slice(i + 1, j), cmd: l.slice(j + 1) }; }).filter((r) => r.pid);
  }
  const out = execSync("ps -axo pid=,ppid=,command=", { maxBuffer: 1 << 26 }).toString();
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], cmd: m[3] });
  }
  return rows;
}

/** The browser process (the one carrying the profile directory on its command line) and everything under it. */
export function processTree(dir) {
  const rows = processes(), kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const tree = [], seen = new Set();
  const walk = (r) => { if (seen.has(r.pid)) return; seen.add(r.pid); tree.push(r); for (const k of kids.get(r.pid) || []) walk(k); };
  for (const r of rows.filter((x) => x.cmd.includes(dir) && !x.cmd.includes("--type="))) walk(r);
  return tree;
}

const kb = (text, name) => { const m = new RegExp("^" + name + ":\\s+(\\d+) kB", "m").exec(text); return m ? +m[1] : 0; };

const MEASURES = {
  darwin: {
    what: "physical footprint (macOS `footprint`), which includes compressed and swapped pages",
    sees: true,
    available: () => { try { execSync("command -v footprint", { stdio: "ignore" }); return true; } catch (_e) { return false; } },
    read: (tree) => {
      const fp = execSync("footprint " + tree.map((r) => "-p " + r.pid).join(" ") + " 2>/dev/null", { maxBuffer: 1 << 26 }).toString();
      let mb = 0, hits = 0;
      for (const line of fp.split("\n")) {
        const m = /\[\d+\].*Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(line);
        if (!m) continue;
        hits++;
        mb += +m[1] * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1);
      }
      return hits ? mb : null;
    },
  },
  linux: {
    what: "proportional resident size plus swap (/proc/<pid>/smaps_rollup)",
    sees: true,
    available: () => { try { readFileSync("/proc/self/smaps_rollup"); return true; } catch (_e) { return false; } },
    read: (tree) => {
      let total = 0, hits = 0;
      for (const r of tree) {
        try {
          const t = readFileSync("/proc/" + r.pid + "/smaps_rollup", "utf8");
          total += kb(t, "Pss") + kb(t, "Swap");
          hits++;
        } catch (_e) { /* exited between listing and reading */ }
      }
      return hits ? total / 1024 : null;
    },
  },
  win32: {
    what: "private committed bytes (PrivateMemorySize64), resident or paged out",
    sees: true,
    available: () => true,
    read: (tree) => {
      const ids = tree.map((r) => r.pid).join(",");
      const out = execSync(PS + JSON.stringify("(Get-Process -Id " + ids + " -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum"), { maxBuffer: 1 << 24 }).toString().trim();
      const n = +out;
      return n > 0 ? n / 1048576 : null;
    },
  },
};

/** Resident size from `ps`: the measure that cannot see swapped or compressed memory. Only on request. */
function rssRead(tree) {
  const out = execSync("ps -o rss= -p " + tree.map((r) => r.pid).join(","), { maxBuffer: 1 << 24 }).toString();
  return out.split("\n").reduce((n, l) => n + (+l.trim() || 0), 0) / 1024;
}

/**
 * The memory probe for this machine: { what, sees, mb(dir) }. Exits with an explanation if the platform has no
 * measure that can see swapped memory and `allowRss` is not set.
 */
export function memoryProbe(allowRss) {
  const m = MEASURES[process.platform];
  if (m && m.available()) return { what: m.what, sees: true, mb: (dir) => { const t = processTree(dir); if (!t.length) return 0; try { return m.read(t) ?? 0; } catch (_e) { return 0; } } };
  if (allowRss && process.platform !== "win32") {
    return { what: "resident size (ps): NOT to be trusted under memory pressure, it cannot see swapped or compressed pages", sees: false, mb: (dir) => { const t = processTree(dir); return t.length ? rssRead(t) : 0; } };
  }
  console.error("stress: this platform (" + process.platform + ") has no measure of physical memory the harness can trust here, and resident size cannot see memory the OS has compressed or swapped.\n" +
    "Pass --allow-rss to run with resident size anyway (and keep --limit-mb well under the machine's memory).");
  process.exit(2);
}

/** Ends the browser and everything it started, whatever the platform calls that. */
export function killTree(dir, force) {
  try {
    if (process.platform === "win32") for (const r of processTree(dir)) execSync("taskkill /F /T /PID " + r.pid, { stdio: "ignore" });
    else execSync((force ? "pkill -9 -f " : "pkill -f ") + JSON.stringify(dir), { stdio: "ignore" });
  } catch (_e) { /* none left */ }
}
