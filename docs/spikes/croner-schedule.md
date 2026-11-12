# Spike: `croner` as a pure next-fire calculator

Date: 2026-11-12 · Package: `croner@11.0.0` · Scope: Phase 1 of
`03_impl_argos_playbook_scheduler.md` (FR2.1–FR2.3, FR3.4; decisions D1 and D3).

Everything below was measured against the installed package, first with throwaway scripts against a
temp SQLite database and then as the permanent tests:

- `packages/core/test/schedule/next.test.ts` — parser, DST epochs, `dueFireTimes`, no-timer guard.
- `packages/core/test/durable/doc-revisions.test.ts` — document revision growth (D3).

The goal was to answer four questions before Phase 4 builds a schedule document on top of this
module: does `croner` match the DST rules the spec records, does it ever arm a timer, is an
impossible expression safe, and does a per-fire document rewrite stay bounded in SQLite.

Measured on Node v26.12.1 / npm 11.20.0 on macOS. The host process zone happened to be
`Asia/Saigon`, which is a useful accident: the tests pass it explicitly like every other zone, and
they pass unchanged, so nothing depends on the host time zone. The plan's manual check ("`node -e`
imports `croner` on Node 22.5 and Node 26") was done on Node 26 only; 22.5 was not installed in the
spike environment, and the package's `engines` floor is `>=18`.

## 1. Version and API (D1)

**Chosen: `croner@11.0.0`** (exact pin, `packages/core/package.json`, `package-lock.json`, and the
AGENTS.md pin table). It is the current stable release. The candidate list was 11.0.0 first, then
7.0.8 / 9.x / 10.x only if the DST set failed. **11.0.0 passed every case on the first run**, so no
older version was installed and the "own parser behind the same API" fallback was not needed.

The API used, and nothing else:

| Call | Use |
|---|---|
| `new Cron(expr, { timezone, mode: "5-part", paused: true })` | parse and validate; store nothing (see §2) |
| `nextRun(prev: Date)` | `nextFireAfter` — strictly after `prev` |
| `nextRuns(n, prev)` | `dueFireTimes` (asks for `limit + 1` to detect the cap) |
| `previousRuns(1, reference)` | `dueFireTimes().previous` — strictly before `reference` |

`src/schedule/next.ts` is the **only** file that imports `croner`; the tests import it directly.
No CLI or plugin module imports `src/schedule/`, so `croner` never reaches their graphs (the CLI
and plugin import-graph tests stay green unchanged).

Two library facts the module relies on and documents in code:

- `mode: "5-part"` makes `croner` itself keep seconds at `0` and the year at `*`. The parser also
  counts fields, so a 6-field expression fails before the library's `auto` mode would accept it as
  a seconds-precision pattern.
- `nextRun`/`nextRuns` are **exclusive** of the reference instant. At `2026-01-01T07:00:00.000Z`
  on `0 * * * *`, `nextRun` returns `08:00:00Z`; at `+1 ms` it also returns `08:00:00Z`. That is
  exactly the "strictly after" contract Phase 5 needs when it calls
  `dueFireTimes(spec, nextFireAt - 1, now, 10_001)`.

`previousRuns(1, t)` is also strict: at a fire time it returns the fire *before* `t`. Phase 1
therefore defines `previous` as "the last fire strictly before the window start" (the value a
missed-fire log renders as the start of the gap), and `dueFireTimes` never includes `fromMs` in
the window.

## 2. `croner` never arms a timer

Verified in the shipped source (`node_modules/croner/dist/croner.js`): the constructor calls
`schedule()` only when it is handed a function —

```js
return r !== undefined && z(r) && (this.fn = r, this.schedule()), this
```

Argos passes **only an options object**, with no callback, and adds `paused: true`. There is no
`setTimeout` on the path at all, so the dirty-refresh timer inside `_schedule` cannot exist.

The permanent proof is the test "never calls setTimeout or setInterval from any export": it spies
on `globalThis.setTimeout` and `globalThis.setInterval`, then calls `parseScheduleSpec` (successful
and refused), `nextFireAfter`, and `dueFireTimes`, and asserts zero calls on both spies. Named jobs
are the only module-level state `croner` keeps (`scheduledJobs`), and Argos never passes `name`, so
two specs cannot collide.

## 3. DST: actual results

Measured with fixed UTC epochs; the count is the number of fire times whose **local date** is the
listed day, over `(local day start − 1 ms, local day end]`. All of it is asserted in
`next.test.ts`; the table is the raw result.

| Zone | Local day | Expression | Fires | First (UTC) | Latest (UTC) |
|---|---|---|---|---|---|
| America/New_York | 2026-03-08 (spring forward) | `30 2 * * *` | 1 | 2026-03-08T07:00Z (= 03:00 EDT) | same |
| America/New_York | 2026-03-08 | `30 1 * * *` | 1 | 2026-03-08T06:30Z (= 01:30 EST) | same |
| America/New_York | 2026-03-08 | `0 * * * *` | 23 | 2026-03-08T05:00Z | 2026-03-09T03:00Z |
| America/New_York | 2026-03-08 | `0 7-23 * * *` | 17 | 2026-03-08T11:00Z | 2026-03-09T03:00Z |
| America/New_York | 2026-11-01 (fall back) | `30 2 * * *` | 1 | 2026-11-01T07:30Z (= 02:30 EST) | same |
| America/New_York | 2026-11-01 | `30 1 * * *` | 1 | 2026-11-01T05:30Z (= 01:30 EDT, first pass) | same |
| America/New_York | 2026-11-01 | `0 * * * *` | 25 | 2026-11-01T04:00Z | 2026-11-02T04:00Z |
| America/New_York | 2026-11-01 | `0 7-23 * * *` | 17 | 2026-11-01T12:00Z | 2026-11-02T04:00Z |
| Europe/Berlin | 2026-03-29 (spring forward) | `30 2 * * *` | 1 | 2026-03-29T01:00Z (= 03:00 CEST) | same |
| Europe/Berlin | 2026-03-29 | `30 1 * * *` | 1 | 2026-03-29T00:30Z (= 01:30 CET) | same |
| Europe/Berlin | 2026-03-29 | `0 * * * *` | 23 | 2026-03-28T23:00Z | 2026-03-29T21:00Z |
| Europe/Berlin | 2026-03-29 | `0 7-23 * * *` | 17 | 2026-03-29T05:00Z | 2026-03-29T21:00Z |
| Europe/Berlin | 2026-10-25 (fall back) | `30 2 * * *` | 1 | 2026-10-25T00:30Z (= 02:30 CEST, first pass) | same |
| Europe/Berlin | 2026-10-25 | `30 1 * * *` | 1 | 2026-10-24T23:30Z (= 01:30 CEST) | same |
| Europe/Berlin | 2026-10-25 | `0 * * * *` | 25 | 2026-10-24T22:00Z | 2026-10-25T22:00Z |
| Europe/Berlin | 2026-10-25 | `0 7-23 * * *` | 17 | 2026-10-25T06:00Z | 2026-10-25T22:00Z |
| Asia/Saigon | 2026-03-08 (control, UTC+7) | `30 2 * * *` | 1 | 2026-03-07T19:30Z | same |
| Asia/Saigon | 2026-03-08 | `30 1 * * *` | 1 | 2026-03-07T18:30Z | same |
| Asia/Saigon | 2026-03-08 | `0 * * * *` | 24 | 2026-03-07T17:00Z | 2026-03-08T16:00Z |
| Asia/Saigon | 2026-03-08 | `0 7-23 * * *` | 17 | 2026-03-08T00:00Z | 2026-03-08T16:00Z |
| Asia/Saigon | 2026-11-01 (control) | `30 2 * * *` | 1 | 2026-10-31T19:30Z | same |
| Asia/Saigon | 2026-11-01 | `30 1 * * *` | 1 | 2026-10-31T18:30Z | same |
| Asia/Saigon | 2026-11-01 | `0 * * * *` | 24 | 2026-10-31T17:00Z | 2026-11-01T16:00Z |
| Asia/Saigon | 2026-11-01 | `0 7-23 * * *` | 17 | 2026-11-01T00:00Z | 2026-11-01T16:00Z |

What the table confirms, against the spec's rules:

- **Fixed-time job in a spring gap** (`30 2 * * *`, New York and Berlin): fires once, at the first
  valid instant after the gap — 03:00 local, the transition instant. The next fire is the following
  day's 02:30, so the skipped local time is not replayed.
- **Fixed-time job on a repeated local time** (`30 1` in New York, `30 2` in Berlin): fires once, at
  the first pass. The second pass is not a fire time; `nextFireAfter` on the first occurrence
  returns the next day.
- **Wildcard/range/step job** (`0 * * * *`, `0 7-23 * * *`): Vixie rules. The hourly job fires 23
  times on a spring-forward day and 25 times on a fall-back day, including both passes of the
  repeated hour (`01:00` twice in New York, `02:00` twice in Berlin). `0 7-23 * * *` is exactly 17
  every day in both zones, because the repeated hour (01:00–01:59 in New York, 02:00–02:59 in
  Berlin) is outside the range.
- **Asia/Saigon** (UTC+7, no DST): 24 hourly fires, 17 in `7-23`, one fixed-time fire, at the same
  local minute every day. This is the control that the numbers above come from DST and not from an
  off-by-one in the window.

### Divergence from the plan's wording (not from its rules)

The plan's verification says "`30 1 * * *` and `30 2 * * *` fire once on the repeated hour" for both
zones. That is imprecise: the repeated local hour is 01:00–01:59 in New York and 02:00–02:59 in
Berlin, so in each zone exactly one of the two expressions is *on* the repeated hour and the other
is adjacent to it. What actually holds — and what the tests assert — is stronger and zone-clean:

> Every fixed-time expression fires exactly once per local day: at the first pass of an ambiguous
> local time, or at the first valid instant after a gap.

No rule in the spec is contradicted; only the prose example was zone-specific.

### Search safety

`0 0 30 2 *` returns `null` in ~2 ms; `0 0 31 4 *` does too. `croner` bounds its year walk and
returns `null` instead of looping, so the never-fires case cannot hang. `nextFireAfter` still
defends itself: a non-finite or non-increasing candidate is reported as `null`. `dueFireTimes`
asks for at most `limit + 1` results, so the per-minute-over-eight-days case is bounded by the
limit, not by the window (measured ~0.25 s for `limit: 10_000` on Node 26).

## 4. Document revisions stay bounded (D3)

A scheduled fire rewrites one schedule document per fire, so Phase 1 had to confirm that a write
stores the latest value of a key rather than a new revision of it. The test family uses the exact
options the schedule family will use — session scope, `family: true`, `checkpointWhen: () => true`
— and rewrites one key 1,000 times with a 50-entry payload on a temp `openNodeSqliteStorage`
database (the storage `argos serve` uses).

```text
writes:            1,000
payload:           50 entries; every entry differs on every write
file before:       4,096 bytes   (empty database)
file after:        122,880 bytes (120 KiB)
WAL while open:    ~4.1 MB, deleted on close
limit asserted:    1,048,576 bytes
```

A throwaway run at **10,000** writes produced the same 122,880-byte file, so the size is the
document's page footprint, not a function of the write count. Chord keeps one latest value per
document address; revision history is not part of the main file.

**Outcome: the test is green with the planned assertion; no weakening and no fallback (no
alternative document layout) is needed.** `packages/core/test/durable/doc-revisions.test.ts`
asserts the file is larger than the empty database (so the test is not vacuous), smaller than
1 MiB, and that the last write is readable as the current value.

## 5. Deterministic run id: review of the `ulid` users

FR4.3 plans `ulidFrom(fireAt, sha256(uid + ":" + fireAt))` for a timer fire, so Phase 1 checked
every current user of `ulid` for a hidden assumption that ids are random or monotonic:

| User | Assumption | Verdict for `ulidFrom` |
|---|---|---|
| `durable/ulid.ts` `ulid()` | Module-level `lastTime` + `lastRandom` enforce monotonicity within a millisecond (D14) | `ulidFrom` must not read or write that state; otherwise a deterministic id could rewind the generator or be "incremented". Phase 4 implements it with its own `encode` call. |
| `durable/ulid.ts` `resetUlidState()` | Test-only reset of that state | Only `test/durable/ulid.test.ts` calls it. New tests around `ulidFrom` must not mix in `ulid()` calls that depend on monotonic order without resetting first. |
| `rpc/server.ts` `sortSummaries` | `right.createdAt - left.createdAt \|\| left.id < right.id` | No dependency on randomness or monotonicity: `createdAt` decides first, the id is only the tie-break. A deterministic id whose time prefix is the fire time does not reorder `GET /runs`, because the run's `createdAt` is its record time, not the fire time. |
| `durable/host.ts` `startRun` | `runId = input.id ?? ulid(clock.now())` | Already accepts an explicit id, which is the seam the fire path uses. |
| `durable/ulid.ts` users besides `host.ts` | `durable/tasks/after.ts` (`ulid(now)` for an after-task child) | Unaffected: after-task children keep random ids and do not copy `trigger` (FR8.3). |
| `git/worktree.ts` (`createRunWorktree`) | `runId` becomes `<home>/worktrees/<runId>` and branch `argos/<runId>` | Needs only "no path separators". The ULID alphabet provides that; `ulidFrom` must stay in it (Crockford base32, `^[0-9A-HJKMNP-TV-Z]{26}$`). |
| `durable/mirror.ts` (`RunsIndexDoc`) | Insertion order of `ids` | Order of insertion, not id order; `sortSummaries` re-sorts on read. Unaffected. |

No user of `ulid` requires randomness, so a deterministic id is safe; the only hard requirements
are the 26-character Crockford alphabet and leaving `lastTime`/`lastRandom` untouched.

## Residual risks carried into later phases

- The schedule document is rewritten through the same commit path as the spike's family, but the
  real document is also read in the same commit (Phase 5's guards). The spike covers size, not
  read-then-write contention.
- `previous` is defined as "the last fire strictly before the window start". Phase 5 only consumes
  `first`/`latest`/`count`/`capped`, so if the missed-entry range needs a different edge, the
  definition is the one place to adjust.
- The DST table is fixed to 2026 transitions. A future tzdata change to those dates would fail
  loudly in `next.test.ts`, which is the desired behaviour for a calendar contract.
