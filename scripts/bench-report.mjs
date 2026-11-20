#!/usr/bin/env node
/**
 * `npm run bench:report` — run the benches and render one standalone HTML file.
 *
 * The tables Vitest prints are gone the moment the terminal scrolls, and a bench is only useful when
 * you can compare it with the last one. This script runs `vitest bench` with the JSON reporter (the
 * only reporter that carries the full latency/throughput statistics), then folds the result into a
 * single self-contained page: no CDN, no build step, no network. Open it from the file system, or
 * hand it to a reviewer.
 *
 * Usage:
 *   npm run bench:report                          # run every bench, write bench-report.html
 *   npm run bench:report -- --open                # …and open it in the default browser
 *   npm run bench:report -- --out=tmp/r.html      # write somewhere else
 *   npm run bench:report -- --json=/tmp/bench.json --no-run
 *                                                 # render an existing result (CI artifact, a box
 *                                                 # that cannot run the benches right now)
 *   npm run bench:report -- packages/core/bench/engine.bench.ts
 *                                                 # narrow the run (extra args go to vitest)
 *
 * The page is a snapshot, not a contract: `packages/core/test/perf/budget.test.ts` is what fails a
 * build. See `docs/bench.md` for what each bench measures and why.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = "bench-report.html";

// ------------------------------------------------------------------ args

/** @returns {{ out: string, open: boolean, run: boolean, json: string | null, files: string[] }} */
function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, open: false, run: true, json: null, files: [] };
  for (const arg of argv) {
    if (arg === "--open") options.open = true;
    else if (arg === "--no-run") options.run = false;
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg.startsWith("--json=")) options.json = arg.slice("--json=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (!options.run && options.json === null) {
    // `--no-run` needs something to render; one temp file cannot be guessed, so fail loudly.
    throw new Error("--no-run needs --json=<path>");
  }
  return options;
}

// ------------------------------------------------------------------ running the benches

function runBenchmarks(files, jsonPath) {
  const target = files.length > 0 ? files : ["packages/core/bench"];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["vitest", "bench", "--reporter=json", `--outputFile=${jsonPath}`, ...target],
      { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`vitest bench exited with ${String(code)}`));
    });
  });
}

// ------------------------------------------------------------------ the model

function machineInfo() {
  const cpuList = cpus();
  const first = cpuList[0];
  return {
    cpu: first === undefined ? "unknown CPU" : first.model.trim(),
    cores: cpuList.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    vitest: vitestVersion(),
    commit: gitCommit(),
    generatedAt: Date.now(),
  };
}

function vitestVersion() {
  try {
    const manifest = execFileSync("node", ["-p", "require('./node_modules/vitest/package.json').version"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return manifest.trim();
  } catch {
    return "unknown";
  }
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** JSON reporter output → `[{ file, suites: [{ name, durationMs, tasks }] }]`. */
function buildModel(report) {
  const files = new Map();
  for (const result of report.testResults ?? []) {
    const file = relative(REPO_ROOT, result.name);
    const suites = files.get(file) ?? [];
    for (const assertion of result.assertionResults ?? []) {
      for (const benchmark of assertion.benchmarks ?? []) {
        const tasks = (benchmark.tasks ?? []).map((task) => ({
          name: task.name,
          rank: task.rank,
          mean: task.latency?.mean ?? task.period,
          p50: task.latency?.p50,
          p99: task.latency?.p99,
          max: task.latency?.max,
          rme: task.latency?.rme,
          samples: task.latency?.samplesCount,
          hz: task.throughput?.mean,
          totalMs: task.totalTime,
        }));
        tasks.sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
        const slowest = tasks.reduce((worst, task) => Math.max(worst, task.mean ?? 0), 0);
        suites.push({
          name: benchmark.name === "" ? assertion.title : benchmark.name,
          durationMs: assertion.duration,
          slowest,
          tasks,
        });
      }
    }
    if (suites.length > 0) files.set(file, suites);
  }
  return [...files.entries()]
    .map(([file, suites]) => ({ file, suites }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

// ------------------------------------------------------------------ formatting

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Sub-millisecond values are unreadable in ms: show µs instead. */
function formatMs(value) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 0.001) return `${(value * 1_000_000).toFixed(0)} ns`;
  if (value < 1) return value < 0.01 ? `${value.toFixed(4)} ms` : `${value.toFixed(3)} ms`;
  return `${value.toFixed(2)} ms`;
}

function formatHz(value) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)} k`;
  return Math.round(value).toLocaleString("en-US");
}

function formatTimestamp(value) {
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// ------------------------------------------------------------------ rendering

function renderRow(task, slowest) {
  const share = slowest > 0 ? Math.max(1.5, ((task.mean ?? 0) / slowest) * 100) : 0;
  return `        <tr>
          <td class="rank">${task.rank ?? ""}</td>
          <td class="name">${escapeHtml(task.name)}</td>
          <td class="cost">
            <span class="bar" style="width:${share.toFixed(1)}%"></span>
            <span class="value">${formatMs(task.mean)}</span>
          </td>
          <td class="num">${formatMs(task.p50)}</td>
          <td class="num">${formatMs(task.p99)}</td>
          <td class="num">${formatHz(task.hz)}</td>
          <td class="num">${task.rme === undefined ? "—" : `±${task.rme.toFixed(2)}%`}</td>
          <td class="num">${task.samples === undefined ? "—" : task.samples.toLocaleString("en-US")}</td>
        </tr>`;
}

function renderSuite(suite) {
  const rows = suite.tasks.map((task) => renderRow(task, suite.slowest)).join("\n");
  const slowest = suite.tasks.reduce(
    (worst, task) => ((task.mean ?? 0) > (worst.mean ?? 0) ? task : worst),
    suite.tasks[0] ?? { mean: 0, name: "—" },
  );
  return `    <section class="suite">
      <h3>${escapeHtml(suite.name)} <span class="meta">${suite.tasks.length} bench${
        suite.tasks.length === 1 ? "" : "es"
      } · slowest: ${escapeHtml(slowest.name)} (${formatMs(slowest.mean)}) · ${
        suite.durationMs === undefined ? "—" : `${Math.round(suite.durationMs)} ms wall`
      }</span></h3>
      <table>
        <thead>
          <tr>
            <th class="rank">#</th>
            <th>Bench</th>
            <th class="cost">mean / call</th>
            <th class="num">p50</th>
            <th class="num">p99</th>
            <th class="num">ops/s</th>
            <th class="num">rme</th>
            <th class="num">samples</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </section>`;
}

function renderFile(entry) {
  return `  <article class="file">
    <h2><code>${escapeHtml(entry.file)}</code></h2>
${entry.suites.map((suite) => renderSuite(suite)).join("\n")}
  </article>`;
}

const STYLE = `
:root {
  --bg: #fbfbfa; --panel: #fff; --ink: #1c1d21; --muted: #6b7280; --line: #e6e6e2;
  --accent: #0e7c66; --accent-soft: #d8f2ea; --warn: #b45309; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131416; --panel: #191b1e; --ink: #ecedef; --muted: #9aa0aa; --line: #2a2d32;
    --accent: #35c2a3; --accent-soft: #12312b; --warn: #f0b45f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px 72px; background: var(--bg); color: var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
main { max-width: 1080px; margin: 0 auto; }
header h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.2px; }
header .sub, header .machine { margin: 2px 0; color: var(--muted); font-size: 12.5px; }
header .machine code { font-family: var(--mono); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 24px 0 32px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.card .figure { font-size: 19px; font-weight: 600; margin-top: 2px; }
.card .detail { color: var(--muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
.file { margin: 0 0 34px; }
.file h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px; }
.file h2 code { font-family: var(--mono); font-size: 12px; text-transform: none; letter-spacing: 0; }
.suite { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px 6px; margin-bottom: 14px; }
.suite h3 { margin: 0 0 10px; font-size: 14.5px; }
.suite h3 .meta { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 8px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; padding: 0 8px 6px; border-bottom: 1px solid var(--line); }
td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
.rank { width: 28px; color: var(--muted); }
.num { text-align: right; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
.name { font-family: var(--mono); font-size: 12.5px; }
.cost { width: 34%; position: relative; }
.cost .bar { position: absolute; left: 4px; right: auto; top: 6px; bottom: 6px; background: var(--accent-soft); border-radius: 4px; }
.cost .value { position: relative; font-family: var(--mono); font-size: 12.5px; padding-left: 10px; }
footer { color: var(--muted); font-size: 12.5px; border-top: 1px solid var(--line); margin-top: 12px; padding-top: 16px; }
footer code { font-family: var(--mono); }
footer ul { margin: 8px 0 0; padding-left: 18px; }
`;

function renderHtml(model) {
  const allTasks = model.flatMap((entry) =>
    entry.suites.flatMap((suite) => suite.tasks.map((task) => ({ ...task, suite: suite.name }))),
  );
  const slowest = allTasks.reduce((worst, task) => ((task.mean ?? 0) > (worst.mean ?? 0) ? task : worst), allTasks[0]);
  const fastest = allTasks.reduce((best, task) => ((task.mean ?? Infinity) < (best.mean ?? Infinity) ? task : best), allTasks[0]);
  const samples = allTasks.reduce((total, task) => total + (task.samples ?? 0), 0);
  const wall = allTasks.reduce((total, task) => total + (task.totalMs ?? 0), 0);
  const machine = machineInfo();

  const summary = [
    ["benches", String(allTasks.length), `${model.length} file${model.length === 1 ? "" : "s"}, ${model.reduce((total, entry) => total + entry.suites.length, 0)} groups`],
    ["fastest", formatMs(fastest?.mean), fastest?.name ?? "—"],
    ["slowest", formatMs(slowest?.mean), slowest?.name ?? "—"],
    ["samples", samples.toLocaleString("en-US"), `${(wall / 1000).toFixed(1)} s of measurement`],
  ]
    .map(
      ([label, figure, detail]) =>
        `    <div class="card"><div class="label">${escapeHtml(label)}</div><div class="figure">${escapeHtml(
          figure,
        )}</div><div class="detail">${escapeHtml(detail)}</div></div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Argos bench report — ${escapeHtml(formatTimestamp(machine.generatedAt))}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Argos bench report</h1>
    <p class="sub">${escapeHtml(formatTimestamp(machine.generatedAt))} · commit <code>${escapeHtml(
      machine.commit,
    )}</code> · vitest ${escapeHtml(machine.vitest)}</p>
    <p class="machine">${escapeHtml(machine.cpu)} · ${machine.cores} cores · ${machine.memoryGb} GB · ${escapeHtml(
      machine.os,
    )} ${escapeHtml(machine.arch)} · Node ${escapeHtml(machine.node)}</p>
  </header>
  <section class="cards">
${summary}
  </section>
${model.map((entry) => renderFile(entry)).join("\n")}
  <footer>
    <strong>mean</strong> is the latency per call (the bar is relative to the slowest bench in its
    group); <strong>ops/s</strong> is throughput; <strong>rme</strong> is the relative margin of error
    of the sample, so a large one means the number is not settled. Higher is better only for ops/s.
    <ul>
      <li>Regenerate: <code>npm run bench:report</code> (add <code>-- --open</code> to launch it).</li>
      <li>Gate: <code>npm run test:perf</code> — ceilings and scaling ratios, the hard pass/fail.</li>
      <li>What each bench means and what is deliberately not measured: <code>docs/bench.md</code>.</li>
      <li>This page is a snapshot of one machine; compare it with another run of the same one.</li>
    </ul>
  </footer>
</main>
</body>
</html>
`;
}

// ------------------------------------------------------------------ main

const options = parseArgs(process.argv.slice(2));
const tempDir = options.json === null ? await mkdtemp(join(tmpdir(), "argos-bench-report-")) : null;
const source = options.json ?? join(tempDir ?? tmpdir(), "bench.json");
if (options.run) await runBenchmarks(options.files, source);

const report = JSON.parse(await readFile(source, "utf8"));
const model = buildModel(report);
if (model.length === 0) {
  throw new Error(`no benchmark results in ${source} — was this a "vitest bench" run?`);
}

const outPath = resolve(REPO_ROOT, options.out);
await writeFile(outPath, renderHtml(model), "utf8");
// Keep the JSON when the caller supplied it; drop the temp copy otherwise.
if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });

const benchCount = model.reduce(
  (total, entry) => total + entry.suites.reduce((count, suite) => count + suite.tasks.length, 0),
  0,
);
console.log(`bench report: ${String(benchCount)} benches from ${String(model.length)} files → ${outPath}`);

if (options.open) {
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  spawn(opener, [outPath], { stdio: "ignore", detached: true }).unref();
}
