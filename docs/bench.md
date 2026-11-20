# Benchmarks

Argos has no LLM in its control path, so its hot loops are ordinary deterministic code: the reducer
that decides every transition, the loader that freezes a definition, and the read model every client
renders. Those three are what the bench suite measures, and they are the only places where a
regression is invisible to `npm test` (which asserts behaviour, not cost).

Timings are **machine-dependent by nature**. Nothing in this document is a contract; the numbers are
a reference so a future change has something to compare against.

```sh
npm run bench            # all three bench files, verbose tables (default reporter is silent on a pipe)
npm run bench:report     # the same run as one standalone HTML page (bench-report.html)
npm run test:perf        # the budget guard: ceilings + scaling ratios (a hard pass/fail)
```

Targeted runs:

```sh
npx vitest bench --reporter=verbose packages/core/bench/engine.bench.ts
npx vitest bench --reporter=verbose packages/core/bench/playbook.bench.ts
npx vitest bench --reporter=verbose packages/core/bench/view.bench.ts
```

`--project core` does **not** work for benchmarks in this vitest version: a bench run registers each
project again as `<name> (bench)`, so a name filter matches nothing. Filter by file path instead. The
`--reporter=verbose` flag matters too — the default reporter prints benchmark tables only on a TTY,
so piping `npm run bench` elsewhere would otherwise look like a run that produced nothing.

## What is measured

| File | Subject | Why it matters |
|---|---|---|
| `packages/core/bench/engine.bench.ts` | `next(record, event)` — `tick`, `stepSettled`, `cancel`-free terminal guard; `readySteps`; `createRunRecord`; a whole 25-step run | The reducer runs on **every** task wake. Each call deep-clones the frozen checkpoint and re-freezes it, so the per-event cost has to stay linear in the step count. A quadratic readiness scan would only show up in a large playbook. |
| `packages/core/bench/playbook.bench.ts` | `discoverPlaybooks`, `loadPlaybook` (parse → zod → resolve → expand → validate → hash → deep-freeze), `playbookHash` | Once per `POST /runs`, once per schedule fire, once per file for `argos validate`. It is the fixed price of starting anything. |
| `packages/core/bench/view.bench.ts` | `toRunSummary`, `stepDetailSummaries`, `runView`, `panelView`, `sortRuns`, `groupRuns`, `buildStepLog`, `buildRunLog` | The panel polls every 2 s and re-projects the whole snapshot each frame; the web UI renders the same functions. |

Deliberately **not** benchmarked:

- **SQLite / pi-durable commits.** A run's commit cost is dominated by the storage engine and the
  filesystem, not by Argos; a number here would describe the laptop's disk. The durability suite
  covers correctness, and `argos db stats` covers a real database's size.
- **Paseo and herdr-core round-trips.** Those are network (or socket) calls to another process; the
  fake executors are deterministic but their latency is not Argos'.
- **Anything that reads the clock.** Every fixture uses a fixed epoch, so two runs of the same bench
  compare, and the pure-engine purity rule (no `Date`) is not weakened for the sake of a measurement.

## The HTML report

`npm run bench:report` runs the benches with the JSON reporter — the only one that carries the full
latency/throughput statistics — and folds the result into one self-contained page
(`bench-report.html`, gitignored): no CDN, no build step, no network. It records the machine
(CPU, cores, RAM, OS, Node), the commit and the vitest version, because a number without that context
is not comparable to anything.

- Every group gets a table (mean/p50/p99/ops/s/rme/samples) and a bar scaled to the slowest bench in
  that group, so "who is expensive here" is visible without reading numbers.
- The cards at the top are the range of the run: fastest, slowest, and how much measurement time it
  took. A very wide range inside one group is usually the point of the bench, not a regression.

```sh
npm run bench:report                       # run + write bench-report.html
npm run bench:report -- --open             # …and open it
npm run bench:report -- --out=tmp/r.html    # write elsewhere
npm run bench:report -- --json=/tmp/bench.json --no-run   # render an existing result
npm run bench:report -- packages/core/bench/engine.bench.ts   # narrow the run
```

The page is a snapshot, not a gate: `npm run test:perf` is what fails a build, and
`scripts/bench-report.mjs` shares nothing with it except the fixed fixtures in
`packages/core/bench/support.ts`. Two reports are comparable only when the machine and the commit
line up; keep the JSON (`--json=…`) if you want to diff a run later.

## Reference numbers

Apple M4 Pro (12 cores), macOS 27.0.1, Node 26.12.1 — `npm run bench`, one full run. `mean` is
milliseconds per call; `hz` is calls per second. Treat them as an order of magnitude, not a target.

| Bench | mean (ms) | hz |
|---|---|---|
| `next(tick)` — 10-step chain, first dispatch | 0.0381 | 26 677 |
| `next(tick)` — 100-step chain, nothing due | 0.2680 | 3 770 |
| `next(tick)` — 100-step wide graph, dispatch up to concurrency | 0.3567 | 3 159 |
| `next(tick)` — 100-step chain, deadline reached | 0.2726 | 3 724 |
| `next(tick)` — 100-step chain, terminal (immutable) | 0.00004 | 24 000 086 |
| `next(stepSettled)` — 10-step chain | 0.0398 | 25 460 |
| `next(stepSettled)` — 100-step chain | 0.2976 | 3 369 |
| `readySteps` — 10-step chain | 0.0003 | 3 908 910 |
| `readySteps` — 100-step chain | 0.0037 | 275 771 |
| `createRunRecord` — 10 steps | 0.0092 | 110 522 |
| `createRunRecord` — 100 steps | 0.0824 | 12 220 |
| drive a 25-step chain to completion | 5.2018 | 192 |
| `loadPlaybook` — 10 steps | 0.5277 | 1 927 |
| `loadPlaybook` — 40 steps | 1.5759 | 638 |
| `discoverPlaybooks` over 50 files | 0.0772 | 13 045 |
| `playbookHash` — 10-step IR | 0.0117 | 88 597 |
| `playbookHash` — 40-step IR | 0.0405 | 25 006 |
| `toRunSummary` — 50 steps × 3 attempts | 0.0341 | 29 671 |
| `stepDetailSummaries` — 50 steps × 3 attempts | 0.0504 | 20 319 |
| `runView` — 50-step run | 0.0300 | 36 560 |
| `runView` — 50-step run with detail + history | 0.6331 | 1 674 |
| `panelView` — 200 runs × 10 steps | 1.4543 | 714 |
| `sortRuns` — 200 summaries | 0.0017 | 594 657 |
| `groupRuns` — 200 run views | 0.0034 | 301 431 |
| `buildStepLog` — 500 history events | 0.1917 | 5 234 |
| `buildRunLog` — 500 history events | 0.0002 | 4 599 667 |

Reading the table: a 100-step run costs about 0.3 ms per wake, so a full 100-step chain is roughly
`100 × 2 × 0.3 ms ≈ 60 ms` of pure engine time (the 25-step measurement — 5.2 ms — scales the same
way). That is far below any executor round-trip: the engine is not the bottleneck, and these benches
exist to keep it that way. The step count is what drives the cost, because `next()` JSON-compares the
whole checkpoint on every event; that is the price of the frozen-record contract, not an accident.

The one number that looks surprising is `panelView` at ~1.5 ms for 200 runs: each frame maps every
run through `runView`, and a selected run's detail adds avoidable-looking work. It stays cheap
because the projection copies scalars only — the day someone puts a transcript in `RunDetail`, this
bench (and the ceiling below) is what notices.

## The budget guard

`npm run test:perf` runs `packages/core/test/perf/budget.test.ts` (its own vitest project,
`vitest.perf.config.ts`) and fails the build when a hot path crosses a budget. Two kinds of check:

- **ceilings** — about 10× the reference laptop's mean, so a shared CI runner passes and a real
  regression (a clone inside a loop, an accidental `O(n²)`, a projection that starts copying text)
  does not;
- **scaling** — 10× the steps may cost at most 25× the time for `next(stepSettled)`, 15× for the
  summary projection, and 12× for the loader. A ratio holds on a slow machine, which is why the
  regression that matters is expressed this way.

Why it is a separate project: a wall clock is not reproducible, so `npm test` must never gate on one.
This mirrors the E2E suite (`vitest.e2e.config.ts`), which is separated for the same reason —
real processes and real timing.

When you deliberately make something slower (a new field in the read model, an extra hash in the
loader), raise the specific ceiling in `budget.test.ts` in the same commit and say why in the message.
When you make something faster, leave the ceiling alone: headroom is the point.

## Notes and caveats

- **Vite serves ESM exports through getters**, and a bench that calls one millions of times trips
  Vitest's "accessed module export getters too many times" warning. The overhead here is a constant
  per iteration (each bench calls an imported function once per iteration), so the warning is
  suppressed in `packages/core/vitest.config.ts` (`benchmark.suppressExportGetterWarnings`). If you
  ever add a bench that calls an import *inside* a loop, remove that suppression and look at the
  warning instead of trusting the number.
- **`mean` is what the tables report**, but a bench's `p99`/`p999` column is the honest view of a
  process under GC pressure; a wide distribution with a tiny mean means the sample size is too small
  for the measurement, not that the code is fine.
- **The fixtures are generated, not committed** (`packages/core/bench/support.ts`): a checked-in
  YAML/SQLite fixture drifts from the schema and stops being representative the moment a key is
  added. The one exception is the temp repo the loader benches write — it is created and removed
  inside the run.
- **Benchmarks are not tests.** Nothing asserts a result; a bench that quietly stopped measuring the
  thing it names would still pass. `budget.test.ts` is the assertion layer, and it imports the same
  `support.ts` builders, so a fixture change lands in both.
