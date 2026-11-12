/**
 * Phase 4 verification: the schedule registry (FR1, FR2, FR7.1–FR7.5).
 *
 * Nothing fires here — Phase 5 owns the timer — so every case is about what a schedule *stores*:
 * the validated values, the `generation` that aborts a stale fire, the index that decides
 * existence, and the dry check that answers the same codes as `POST /runs` while creating nothing.
 *
 * The fixture is a real repository (a temp checkout with a bare origin) because the dry check loads
 * playbooks and, for `isolation: worktree`, inspects the base checkout exactly as a start would.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type { AddScheduleInput, EditScheduleInput } from "../../src/durable/host.js";
import { isArgosError } from "../../src/errors.js";
import { nextFireAfter, parseScheduleSpec } from "../../src/schedule/next.js";
import { SCHEDULE_LIMIT } from "../../src/schedule/model.js";
import { FAKE_EPOCH, FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo, type TempRepo } from "../support/git.js";
import { makeTempHome, type TempHome } from "./support.js";

// ------------------------------------------------------------------ playbooks

const NIGHTLY = `title: Nightly
inputs:
  label:
    type: string
    default: hello
steps:
  - id: a
    prompt: Do the work.
`;

const REQUIRED_INPUT = `title: Required
inputs:
  count:
    type: number
    required: true
steps:
  - id: a
    prompt: Count {{ inputs.count }}.
`;

const SCRIPTED = `title: Scripted
steps:
  - id: build
    kind: script
    script:
      run: missing.sh
`;

const ISOLATED = `title: Isolated
isolation: worktree
steps:
  - id: a
    prompt: Do the work.
`;

// ------------------------------------------------------------------ fixtures

interface Fixture {
  host: ArgosHost;
  readonly clock: FakeClock;
  readonly storage: MemoryStorage;
  readonly home: TempHome;
  readonly repo: TempRepo;
}

const fixtures: Fixture[] = [];
const repositories: TempRepo[] = [];

function writePlaybook(repo: string, id: string, yaml: string): void {
  const directory = join(repo, ".argos", "playbooks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.yaml`), yaml, "utf8");
}

/** A clean checkout (the playbooks are committed) with one host on in-memory storage. */
async function makeFixture(
  playbooks: Readonly<Record<string, string>> = { nightly: NIGHTLY },
): Promise<Fixture> {
  const repo = makeTempRepo();
  repositories.push(repo);
  for (const [id, yaml] of Object.entries(playbooks)) writePlaybook(repo.repo, id, yaml);
  repo.git(["add", "-A"]);
  repo.git(["commit", "--quiet", "-m", "playbooks"]);

  const home = makeTempHome();
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  const host = await ArgosHost.open({
    storage,
    home: home.home,
    clock,
    executor: new FakeExecutor(),
  });
  const fixture: Fixture = { host, clock, storage, home, repo };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    await fixture.host.close();
    fixture.home.cleanup();
  }
  while (repositories.length > 0) repositories.pop()?.cleanup();
});

// ------------------------------------------------------------------ helpers

function codeOf(error: unknown): string {
  return isArgosError(error) ? error.code : `<not an ArgosError: ${String(error)}>`;
}

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

/** The exact instant the model must store for an expression at `after`. */
function fireTimeAfter(cron: string, tz: string, after: number): number {
  const next = nextFireAfter(parseScheduleSpec(cron, tz), after);
  if (next === null) throw new Error(`${cron} never fires`);
  return next;
}

/** Nothing a dry check touches may exist afterwards (FR2.4). */
async function assertNothingCreated(fixture: Fixture): Promise<void> {
  expect((await fixture.host.inspect()).tasks).toHaveLength(0);
  expect(await fixture.host.listRuns()).toHaveLength(0);
  expect(existsSync(join(fixture.home.home, "worktrees"))).toBe(false);
}

// ------------------------------------------------------------------ CRUD

describe("schedule registry (FR1, FR7)", () => {
  it("round-trips add, get, list, edit, pause, resume, and remove", async () => {
    const fixture = await makeFixture();
    const { host, clock } = fixture;
    const now = clock.now();

    const added = await host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "0 7 * * *",
      tz: "UTC",
      inputs: { label: "hi" },
      overlap: "allow",
      catchUp: "30m",
      keep: 5,
    });
    // FR1.2/FR1.3: the id defaults to the playbook id and the uid is a fresh ULID.
    expect(added.id).toBe("nightly");
    expect(added.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(added.playbookId).toBe("nightly");
    expect(added.cwd).toBe(fixture.repo.repo);
    expect(added.inputs).toEqual({ label: "hi" });
    expect(added.overlap).toBe("allow");
    expect(added.catchUp).toBe(1_800_000);
    expect(added.keep).toBe(5);
    expect(added.enabled).toBe(true);
    expect(added.generation).toBe(0);
    expect(added.createdAt).toBe(now);
    expect(added.updatedAt).toBe(now);
    expect(added.nextFireAt).toBe(fireTimeAfter("0 7 * * *", "UTC", now));
    expect(added.runIds).toEqual([]);
    expect(added.fires).toEqual([]);
    expect(added.consecutiveFailures).toBe(0);

    expect((await host.getSchedule("nightly"))?.uid).toBe(added.uid);
    expect((await host.listSchedules()).map((doc) => doc.id)).toEqual(["nightly"]);

    // FR7.2: the edit replaces `inputs` as a whole and advances the generation.
    const edited = await host.editSchedule("nightly", {
      inputs: { label: "bye" },
      keep: 10,
      cron: "@daily",
    });
    expect(edited.inputs).toEqual({ label: "bye" });
    expect(edited.keep).toBe(10);
    expect(edited.cron).toBe("@daily");
    expect(edited.generation).toBe(1);
    expect(edited.uid).toBe(added.uid);
    expect(edited.createdAt).toBe(now);
    expect(edited.nextFireAt).toBe(fireTimeAfter("@daily", "UTC", clock.now()));

    // FR7.3: pause clears the next fire time and advances the generation.
    const paused = await host.pauseSchedule("nightly");
    expect(paused.enabled).toBe(false);
    expect(paused.nextFireAt).toBeNull();
    expect(paused.generation).toBe(2);

    // FR7.4: resume schedules from now.
    const resumed = await host.resumeSchedule("nightly");
    expect(resumed.enabled).toBe(true);
    expect(resumed.generation).toBe(3);
    expect(resumed.nextFireAt).toBe(fireTimeAfter("@daily", "UTC", clock.now()));
    expect(resumed.nextFireAt ?? 0).toBeGreaterThan(clock.now());

    // FR7.5: remove retires the document and drops the index entry.
    await host.removeSchedule("nightly");
    expect(await host.getSchedule("nightly")).toBeUndefined();
    expect(await host.listSchedules()).toEqual([]);
    expect(codeOf(await errorOf(() => host.removeSchedule("nightly")))).toBe("schedule_unknown");
  });

  it("creates a paused schedule with no next fire time when asked (FR7.1)", async () => {
    const fixture = await makeFixture();
    const doc = await fixture.host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@hourly",
      tz: "UTC",
      enabled: false,
    });
    expect(doc.enabled).toBe(false);
    expect(doc.nextFireAt).toBeNull();
  });

  it("defaults the id to the playbook id and refuses one that is not a valid id (FR1.2)", async () => {
    const fixture = await makeFixture();
    const { host, clock } = fixture;

    const explicit = await host.addSchedule({
      id: "team-nightly",
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
      tz: "UTC",
    });
    expect(explicit.id).toBe("team-nightly");

    // A playbook id that cannot be a schedule id needs an explicit `--id`.
    expect(
      codeOf(
        await errorOf(() =>
          host.addSchedule({
            playbookId: "Nightly_Report",
            cwd: fixture.repo.repo,
            cron: "@daily",
            tz: "UTC",
          }),
        ),
      ),
    ).toBe("invalid_request");
    // An explicit id outside the pattern is refused too.
    expect(
      codeOf(
        await errorOf(() =>
          host.addSchedule({
            id: "Not An Id",
            playbookId: "nightly",
            cwd: fixture.repo.repo,
            cron: "@daily",
            tz: "UTC",
          }),
        ),
      ),
    ).toBe("invalid_request");
    expect((await host.listSchedules()).map((doc) => doc.id)).toEqual(["team-nightly"]);
    expect(clock.now()).toBe(FAKE_EPOCH);
  });

  it("refuses a duplicate id with schedule_exists (FR1.6)", async () => {
    const fixture = await makeFixture();
    const add = () =>
      fixture.host.addSchedule({
        playbookId: "nightly",
        cwd: fixture.repo.repo,
        cron: "@daily",
        tz: "UTC",
      });
    await add();
    const error = await errorOf(add);
    expect(codeOf(error)).toBe("schedule_exists");
    expect((await fixture.host.listSchedules()).map((doc) => doc.id)).toEqual(["nightly"]);
  });

  it(`refuses the ${SCHEDULE_LIMIT + 1}st schedule with invalid_request (FR1.5)`, async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    for (let index = 0; index < SCHEDULE_LIMIT; index += 1) {
      await host.addSchedule({
        id: `s-${String(index)}`,
        playbookId: "nightly",
        cwd: fixture.repo.repo,
        cron: "@daily",
        tz: "UTC",
      });
    }
    expect(await host.listSchedules()).toHaveLength(SCHEDULE_LIMIT);

    const error = await errorOf(() =>
      host.addSchedule({
        id: "one-too-many",
        playbookId: "nightly",
        cwd: fixture.repo.repo,
        cron: "@daily",
        tz: "UTC",
      }),
    );
    expect(codeOf(error)).toBe("invalid_request");
    expect(await host.listSchedules()).toHaveLength(SCHEDULE_LIMIT);
  });

  it("refuses an unknown id with schedule_unknown (FR1.7)", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    expect(codeOf(await errorOf(() => host.editSchedule("nope", { cron: "@daily" })))).toBe(
      "schedule_unknown",
    );
    expect(codeOf(await errorOf(() => host.pauseSchedule("nope")))).toBe("schedule_unknown");
    expect(codeOf(await errorOf(() => host.resumeSchedule("nope")))).toBe("schedule_unknown");
    expect(codeOf(await errorOf(() => host.removeSchedule("nope")))).toBe("schedule_unknown");
    expect(await host.getSchedule("nope")).toBeUndefined();
  });

  it("refuses an edit that changes nothing (FR7.2)", async () => {
    const fixture = await makeFixture();
    await fixture.host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
      tz: "UTC",
    });
    expect(codeOf(await errorOf(() => fixture.host.editSchedule("nightly", {})))).toBe(
      "invalid_request",
    );
  });

  it("gives a deleted and re-added schedule a new uid (FR1.3)", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    const input = {
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
      tz: "UTC",
    } as const;
    const first = await host.addSchedule(input);
    await host.removeSchedule(first.id);
    const second = await host.addSchedule(input);
    expect(second.uid).not.toBe(first.uid);
    expect(second.generation).toBe(0);
  });

  it("stores the server zone when tz is omitted (FR2.2)", async () => {
    const fixture = await makeFixture();
    const doc = await fixture.host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
    });
    expect(doc.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The stored zone wins over the process zone from then on.
    const edited = await fixture.host.editSchedule("nightly", { tz: "Asia/Saigon" });
    expect(edited.tz).toBe("Asia/Saigon");
    expect(edited.nextFireAt).toBe(fireTimeAfter("@daily", "Asia/Saigon", fixture.clock.now()));
  });
});

// ------------------------------------------------------------------ validation

describe("schedule validation (FR2)", () => {
  const base = (fixture: Fixture) => ({
    playbookId: "nightly",
    cwd: fixture.repo.repo,
    cron: "@daily",
    tz: "UTC",
  });

  it("refuses a bad cron, a bad tz, and an expression that never fires (FR2.1–FR2.3)", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["six fields", { cron: "0 0 7 * * *" }],
      ["@reboot", { cron: "@reboot" }],
      ["nonsense", { cron: "every day" }],
      ["bad tz", { tz: "Mars/Base" }],
      ["impossible date", { cron: "0 0 30 2 *" }],
    ];
    for (const [label, patch] of cases) {
      const error = await errorOf(() =>
        host.addSchedule({ ...base(fixture), ...patch } as unknown as AddScheduleInput),
      );
      expect(codeOf(error), label).toBe("invalid_request");
    }
    expect(await host.listSchedules()).toEqual([]);
    await assertNothingCreated(fixture);
  });

  it("refuses a bad catchUp or keep with invalid_request (FR3.5, FR9.1)", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    for (const catchUp of ["1w", -1, "soon"]) {
      expect(
        codeOf(
          await errorOf(() =>
            host.addSchedule(
              { ...base(fixture), catchUp } as unknown as AddScheduleInput,
            ),
          ),
        ),
        `catchUp ${String(catchUp)}`,
      ).toBe("invalid_request");
    }
    for (const keep of [0, 1_001, 2.5]) {
      expect(
        codeOf(
          await errorOf(() =>
            host.addSchedule({ ...base(fixture), keep } as unknown as AddScheduleInput),
          ),
        ),
        `keep ${String(keep)}`,
      ).toBe("invalid_request");
    }
    expect(await host.listSchedules()).toEqual([]);
    await assertNothingCreated(fixture);
  });

  it("re-validates every merged value on edit, and a refused edit changes nothing (FR7.2)", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    const added = await host.addSchedule(base(fixture));

    for (const patch of [
      { cron: "0 0 30 2 *" },
      { tz: "Mars/Base" },
      { catchUp: "1w" },
      { keep: 0 },
      { cwd: "relative/repo" },
    ]) {
      const error = await errorOf(() =>
        host.editSchedule("nightly", patch as unknown as EditScheduleInput),
      );
      expect(codeOf(error), JSON.stringify(patch)).toBe("invalid_request");
    }
    const stored = await host.getSchedule("nightly");
    expect(stored).toEqual(added);
  });
});

// ------------------------------------------------------------------ dry check (FR2.4)

describe("dry start check (FR2.4)", () => {
  it("answers the POST /runs codes and creates no run, task, or worktree", async () => {
    const fixture = await makeFixture({
      nightly: NIGHTLY,
      required: REQUIRED_INPUT,
      scripted: SCRIPTED,
      isolated: ISOLATED,
    });
    const { host, repo } = fixture;

    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ["unknown playbook", { playbookId: "ghost" }, "playbook_missing"],
      ["missing required input", { playbookId: "required" }, "invalid_request"],
      ["missing script", { playbookId: "scripted" }, "playbook_invalid"],
      ["bad cwd", { cwd: join(repo.repo, "..", "nowhere") }, "invalid_request"],
    ];
    for (const [label, patch, expected] of refusals) {
      const error = await errorOf(() =>
        host.addSchedule({
          playbookId: "nightly",
          cwd: repo.repo,
          cron: "@daily",
          tz: "UTC",
          ...patch,
        } as unknown as AddScheduleInput),
      );
      expect(codeOf(error), label).toBe(expected);
    }
    expect(await host.listSchedules()).toEqual([]);
    await assertNothingCreated(fixture);

    // A clean base passes the same worktree check a start would run, and still creates nothing.
    const isolated = await host.addSchedule({
      playbookId: "isolated",
      cwd: repo.repo,
      cron: "@daily",
      tz: "UTC",
      isolation: "worktree",
    });
    expect(isolated.isolation).toBe("worktree");
    await assertNothingCreated(fixture);

    // Dirty the base: the dry check answers `worktree_base_dirty`, as `POST /runs` would.
    writeFileSync(join(repo.repo, "uncommitted.txt"), "not committed\n", "utf8");
    const error = await errorOf(() =>
      host.addSchedule({
        id: "dirty",
        playbookId: "isolated",
        cwd: repo.repo,
        cron: "@daily",
        tz: "UTC",
        isolation: "worktree",
      }),
    );
    expect(codeOf(error)).toBe("worktree_base_dirty");
    expect((await host.listSchedules()).map((doc) => doc.id)).toEqual(["isolated"]);
    await assertNothingCreated(fixture);
  });

  it("refuses with storage_locked once the host is closed", async () => {
    const fixture = await makeFixture();
    const doc = await fixture.host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
      tz: "UTC",
    });
    await fixture.host.close();
    for (const call of [
      () => fixture.host.addSchedule({
        playbookId: "nightly",
        cwd: fixture.repo.repo,
        cron: "@daily",
        tz: "UTC",
      }),
      () => fixture.host.editSchedule(doc.id, { keep: 1 }),
      () => fixture.host.pauseSchedule(doc.id),
      () => fixture.host.resumeSchedule(doc.id),
      () => fixture.host.removeSchedule(doc.id),
      () => fixture.host.getSchedule(doc.id),
      () => fixture.host.listSchedules(),
    ]) {
      expect(codeOf(await errorOf(call))).toBe("storage_locked");
    }
  });
});

// ------------------------------------------------------------------ timing

describe("schedule timing (FR7.2–FR7.4)", () => {
  it("recomputes nextFireAt from now on edit (FR7.2)", async () => {
    const fixture = await makeFixture();
    const { host, clock } = fixture;
    await host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "0 * * * *",
      tz: "UTC",
    });
    const start = clock.now();
    expect((await host.getSchedule("nightly"))?.nextFireAt).toBe(
      fireTimeAfter("0 * * * *", "UTC", start),
    );

    await clock.advance(30 * 60_000);
    const after = clock.now();
    const edited = await host.editSchedule("nightly", { keep: 3 });
    expect(edited.nextFireAt).toBe(fireTimeAfter("0 * * * *", "UTC", after));
    expect(edited.nextFireAt).not.toBe(fireTimeAfter("0 * * * *", "UTC", start));
    expect(edited.generation).toBe(1);
  });

  it("does not catch up the fire times inside a pause (FR7.4)", async () => {
    const fixture = await makeFixture();
    const { host, clock } = fixture;
    await host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "0 * * * *",
      tz: "UTC",
    });
    const before = await host.getSchedule("nightly");
    const paused = await host.pauseSchedule("nightly");
    expect(paused.nextFireAt).toBeNull();
    expect(paused.generation).toBe(1);

    // Three hours pass while paused: those fire times are gone, not queued.
    await clock.advance(3 * 60 * 60_000);
    const resumed = await host.resumeSchedule("nightly");
    expect(resumed.enabled).toBe(true);
    expect(resumed.generation).toBe(2);
    expect(resumed.nextFireAt).toBe(fireTimeAfter("0 * * * *", "UTC", clock.now()));
    expect(resumed.nextFireAt ?? 0).toBeGreaterThan(clock.now());
    expect(resumed.nextFireAt).not.toBe(before?.nextFireAt);
  });

  it("keeps the other fields when pausing and resuming", async () => {
    const fixture = await makeFixture();
    const { host } = fixture;
    const added = await host.addSchedule({
      playbookId: "nightly",
      cwd: fixture.repo.repo,
      cron: "@daily",
      tz: "UTC",
      inputs: { label: "kept" },
      overlap: "allow",
      catchUp: 0,
      keep: "all",
    });
    const paused = await host.pauseSchedule("nightly");
    const resumed = await host.resumeSchedule("nightly");
    expect(resumed.inputs).toEqual(added.inputs);
    expect(resumed.overlap).toBe("allow");
    expect(resumed.catchUp).toBe(0);
    expect(resumed.keep).toBe("all");
    expect(paused.uid).toBe(added.uid);
    expect(resumed.uid).toBe(added.uid);
    expect(resumed.createdAt).toBe(added.createdAt);
  });
});

// ------------------------------------------------------------------ persistence

describe("schedule persistence (FR1.1)", () => {
  it("keeps the documents and the index across a host reopen", async () => {
    // MemoryStorage cannot be reopened, so this one case uses the real `$ARGOS_HOME` SQLite file.
    const home = makeTempHome();
    const repo = makeTempRepo();
    repositories.push(repo);
    writePlaybook(repo.repo, "nightly", NIGHTLY);
    repo.git(["add", "-A"]);
    repo.git(["commit", "--quiet", "-m", "playbook"]);
    const clock = new FakeClock();

    const added = await (async () => {
      const first = await ArgosHost.open({ home: home.home, clock, executor: new FakeExecutor() });
      try {
        const doc = await first.addSchedule({
          playbookId: "nightly",
          cwd: repo.repo,
          cron: "@daily",
          tz: "UTC",
          inputs: { label: "persisted" },
        });
        await first.pauseSchedule("nightly");
        return doc;
      } finally {
        await first.close();
      }
    })();

    try {
      const second = await ArgosHost.open({ home: home.home, clock, executor: new FakeExecutor() });
      try {
        const list = await second.listSchedules();
        expect(list.map((doc) => doc.id)).toEqual(["nightly"]);
        const stored = list[0];
        expect(stored?.uid).toBe(added.uid);
        expect(stored?.inputs).toEqual({ label: "persisted" });
        expect(stored?.enabled).toBe(false);
        expect(stored?.nextFireAt).toBeNull();
        expect(stored?.generation).toBe(1);
        expect(stored?.createdAt).toBe(added.createdAt);
      } finally {
        await second.close();
      }

      // A removed schedule stays removed: the index is what a reopen reads first.
      const third = await ArgosHost.open({ home: home.home, clock, executor: new FakeExecutor() });
      try {
        await third.removeSchedule("nightly");
        expect(await third.listSchedules()).toEqual([]);
      } finally {
        await third.close();
      }
    } finally {
      home.cleanup();
    }
  });
});
