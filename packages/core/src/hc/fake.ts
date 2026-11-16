/**
 * The deterministic fake {@link HcPort} behind the test-only `ARGOS_FAKE_EXECUTOR=hc` (Phase 7).
 *
 * It is the hc counterpart of `src/paseo/fake.ts`, and it exists for the same reason: `argos serve`
 * cannot import from `packages/core/test/`, so the production-side test-only fake lives in `src/`
 * while `test/fakes/hc.ts` stays the richer unit-test fake the adapter suites drive by hand. No
 * socket is ever opened and no program is ever spawned: a created terminal "runs" a template and is
 * reported `working` once, then `finished` with exit code `0` on the next poll.
 *
 * Two modes, exactly like the Paseo fake:
 *
 * - **In-memory** (default, `createFakeHcPort()`): nothing is written.
 * - **File-backed** (`statePath` set; `argos serve` passes `$ARGOS_HOME` or `ARGOS_FAKE_HC_DIR`):
 *   terminals and their labels are persisted as `fake-hc.json` and every creation is appended to
 *   `fake-hc-launches.jsonl`. That is what lets a `SIGKILL`ed `argos serve` restart and adopt the
 *   terminals it created in its previous lifetime instead of launching them a second time. The
 *   JSONL ledger is the append-only creation evidence (the E2E counts it); the JSON file is the
 *   atomically rewritten readable snapshot — and the authority for a terminal's *state*, so a
 *   terminal that already finished is not re-run after a restart.
 *
 * Test-only environment knobs (read by `argos serve`, never by production code paths):
 *
 * - `ARGOS_FAKE_EXECUTOR=hc` — select this fake instead of a real herdr-core socket.
 * - `ARGOS_FAKE_HC_DIR` — state directory; defaults to `$ARGOS_HOME`.
 * - `ARGOS_FAKE_HC_BLOCK_STEP=<stepId>` — that step's terminal reports `working` until the release
 *   file exists. Used to hold a run mid-step for the kill/restart scenario.
 * - `ARGOS_FAKE_HC_RELEASE_FILE=<path>` — the file whose appearance releases the blocked step
 *   (checked on every status poll; the E2E playbook polls every 50 ms).
 *
 * The names it hands out are compatible with hc's own rule (1–32 of `[a-z0-9-_]`): the adapter
 * generates `argos-<16 hex>` and the fake only ever echoes it back.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HcKindError,
  HC_PROTOCOL_GENERATION,
  type HcCoreInfo,
  type HcFirstMessage,
  type HcHello,
  type HcKillResult,
  type HcListOptions,
  type HcPort,
  type HcReadOptions,
  type HcReadResult,
  type HcRemoveResult,
  type HcRunInput,
  type HcRunResult,
  type HcSendInput,
  type HcSendResult,
  type HcServerStatus,
  type HcTemplate,
  type HcTerminal,
  type HcTerminalStatus,
} from "./port.js";

/** File names inside the state directory; exported so tests can assert the layout. */
export const FAKE_HC_STATE_FILE = "fake-hc.json";
export const FAKE_HC_LAUNCHES_FILE = "fake-hc-launches.jsonl";

/** The version the fake core reports (a development build, never a real release). */
export const FAKE_HC_VERSION = "fake";

/** The templates the fake core offers (`templates.list`), unless a caller supplies its own. */
export const FAKE_HC_TEMPLATES = ["claude", "codex"] as const;

/**
 * The result text every fake terminal ends with. It is a bare JSON object, so a playbook that
 * declares `outputs: {summary}` / `outcomes: [success, …]` settles those outputs through the same
 * fenced-JSON fallback a real hc run uses; a playbook with no declared outputs never reads it.
 */
export const FAKE_HC_RESULT_TEXT = '{"summary":"fake hc step","outcome":"success"}';

const DEFAULT_CORE: HcCoreInfo = { id: "fake-core", name: "fake-hc" };

export interface FakeHcPortOptions {
  /** Persist terminals and the creation ledger in this directory (the E2E restart proof). */
  readonly statePath?: string;
  /** Template names `templates.list` offers; default {@link FAKE_HC_TEMPLATES}. */
  readonly templates?: readonly string[];
  /** Environment used for the block/release knobs; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Blocked step id override (default `ARGOS_FAKE_HC_BLOCK_STEP`). */
  readonly blockStep?: string;
  /** Release file override (default `ARGOS_FAKE_HC_RELEASE_FILE`). */
  readonly releaseFile?: string;
  /**
   * Finish a created terminal on this poll (default `1`): the first `terminal.get` after creation
   * reports the program done. `0`/a negative value parks it forever, which models a program that
   * never reports status.
   */
  readonly completeAfterPolls?: number;
  /** Version the fake core reports; default {@link FAKE_HC_VERSION}. */
  readonly version?: string;
}

/** One `terminal.run` the fake accepted, as persisted in the append-only creation ledger. */
export interface FakeHcLaunch {
  readonly requestId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly name: string;
  readonly address: string;
  readonly template: string | null;
  readonly at: number;
  /** The `argos serve` process that created the terminal (proves the cross-lifetime ledger). */
  readonly pid: number;
}

/** The fake's persisted terminal shape: the port's `HcTerminal` plus the poll bookkeeping. */
interface StoredTerminal {
  address: string;
  name: string;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  template: string | null;
  state: "live" | "finished";
  /** The program's status word, or `null` once it exited / never reported. */
  statusWord: string | null;
  turn: number;
  exit_code: number | null;
  signal: number | null;
  reason: string | null;
  created_ms: number;
  finished_ms: number | null;
  text: string;
  reported: boolean;
  first_message: HcFirstMessage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Read one persisted terminal, or `undefined` when the row is not a terminal. */
function toStored(value: unknown): StoredTerminal | undefined {
  if (!isRecord(value)) return undefined;
  const address = value["address"];
  const name = value["name"];
  if (typeof address !== "string" || address.length === 0) return undefined;
  if (typeof name !== "string") return undefined;
  const first = value["first_message"];
  return {
    address,
    name,
    labels: stringRecord(value["labels"]),
    argv: stringList(value["argv"]),
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : "",
    template: nullableString(value["template"]),
    state: value["state"] === "finished" ? "finished" : "live",
    statusWord: nullableString(value["statusWord"]),
    turn: numberOr(value["turn"], 0),
    exit_code: nullableNumber(value["exit_code"]),
    signal: nullableNumber(value["signal"]),
    reason: nullableString(value["reason"]),
    created_ms: numberOr(value["created_ms"], 0),
    finished_ms: nullableNumber(value["finished_ms"]),
    text: typeof value["text"] === "string" ? value["text"] : "",
    reported: value["reported"] === true,
    first_message:
      isRecord(first) && typeof first["sent"] === "boolean"
        ? {
            sent: first["sent"],
            started: typeof first["started"] === "boolean" ? first["started"] : null,
            turn: nullableNumber(first["turn"]),
            reason: nullableString(first["reason"]),
          }
        : null,
  };
}

/** Read every valid line of an append-only JSONL ledger (a torn tail line is ignored). */
function readLaunches(file: string): FakeHcLaunch[] {
  if (!existsSync(file)) return [];
  const launches: FakeHcLaunch[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) continue;
      const { requestId, stepId, attempt, name, address, template, at, pid } = parsed;
      if (
        typeof requestId === "string" &&
        typeof stepId === "string" &&
        typeof attempt === "number" &&
        typeof name === "string" &&
        typeof address === "string" &&
        typeof at === "number" &&
        typeof pid === "number"
      ) {
        launches.push({
          requestId,
          stepId,
          attempt,
          name,
          address,
          template: nullableString(template),
          at,
          pid,
        });
      }
    } catch {
      // A kill during an append can leave a partial final line; the next write rewrites the state.
    }
  }
  return launches;
}

/** Rebuild a live terminal from one ledger creation (a crash between the append and the rewrite). */
function launchToStored(launch: FakeHcLaunch): StoredTerminal {
  return {
    address: launch.address,
    name: launch.name,
    labels: {
      "argos/launch": launch.requestId,
      "argos/step": launch.stepId,
      "argos/attempt": String(launch.attempt),
    },
    argv: launch.template === null ? [] : [launch.template],
    cwd: "",
    template: launch.template,
    state: "live",
    statusWord: "working",
    turn: 0,
    exit_code: null,
    signal: null,
    reason: null,
    created_ms: launch.at,
    finished_ms: null,
    text: "",
    reported: true,
    first_message:
      launch.template === null
        ? null
        : { sent: true, started: true, turn: 0, reason: null },
  };
}

interface FileState {
  load(): { terminals: StoredTerminal[]; nextAddress: number };
  append(launch: FakeHcLaunch): void;
  save(terminals: readonly StoredTerminal[], nextAddress: number): void;
}

/**
 * The file-backed registry. The JSONL ledger is append-only (it survives a `SIGKILL` and is the
 * creation evidence); `fake-hc.json` is rewritten atomically and holds the terminals' state.
 */
function createFileState(directory: string): FileState {
  const stateFile = join(directory, FAKE_HC_STATE_FILE);
  const launchesFile = join(directory, FAKE_HC_LAUNCHES_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return {
    load() {
      let nextAddress = 1;
      const terminals: StoredTerminal[] = [];
      if (existsSync(stateFile)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
          if (isRecord(parsed)) {
            const rows = Array.isArray(parsed["terminals"]) ? parsed["terminals"] : [];
            for (const row of rows) {
              const terminal = toStored(row);
              if (terminal !== undefined) terminals.push(terminal);
            }
            nextAddress = Math.max(nextAddress, numberOr(parsed["nextAddress"], 1));
          }
        } catch {
          // A corrupt snapshot is not fatal: the ledger below still names every creation.
        }
      }
      const launches = readLaunches(launchesFile);
      const known = new Set(terminals.map((terminal) => terminal.address));
      for (const launch of launches) {
        if (known.has(launch.address)) continue;
        // A crash between the ledger append and the snapshot rewrite: adopt the creation as live.
        terminals.push(launchToStored(launch));
        known.add(launch.address);
      }
      for (const terminal of terminals) {
        const numeric = Number.parseInt(terminal.address.replace(/^t/, ""), 10);
        if (Number.isInteger(numeric) && numeric >= nextAddress) nextAddress = numeric + 1;
      }
      return { terminals, nextAddress };
    },

    append(launch: FakeHcLaunch) {
      appendFileSync(launchesFile, `${JSON.stringify(launch)}\n`, { mode: 0o600 });
    },

    save(terminals: readonly StoredTerminal[], nextAddress: number) {
      const temporary = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, nextAddress, terminals }, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(temporary, stateFile);
    },
  };
}

/** `argos/attempt` as a number, for the readable creation ledger. */
function attemptOf(terminal: StoredTerminal): number {
  const attempt = Number.parseInt(terminal.labels["argos/attempt"] ?? "", 10);
  return Number.isInteger(attempt) ? attempt : 1;
}

function statusOf(word: string | null): HcTerminalStatus | null {
  if (word === null) return null;
  return { state: word, msg: null, title: null, kind: null, progress: null };
}

function toTerminal(stored: StoredTerminal): HcTerminal {
  const numeric = Number.parseInt(stored.address.replace(/^t/, ""), 10);
  return {
    address: stored.address,
    name: stored.name,
    state: stored.state,
    status: statusOf(stored.statusWord),
    turn: stored.turn,
    exit_code: stored.exit_code,
    signal: stored.signal,
    reason: stored.reason,
    labels: { ...stored.labels },
    argv: [...stored.argv],
    cwd: stored.cwd,
    pid: stored.state === "finished" ? null : (Number.isInteger(numeric) ? 1000 + numeric : null),
    created_ms: stored.created_ms,
    finished_ms: stored.finished_ms,
    screen: "exact",
    title: "",
    reported: stored.reported,
    template: stored.template,
    first_message: stored.first_message === null ? null : { ...stored.first_message },
  };
}

/**
 * The fake port plus the counters a test needs (the production code only ever sees {@link HcPort}).
 * Every array is a live view, so a test can assert "exactly one delivery / one removal".
 */
export interface FakeHc extends HcPort {
  /** Template names `templates.list` offers. */
  readonly templateNames: readonly string[];
  readonly sends: readonly HcSendInput[];
  readonly removes: readonly string[];
  readonly kills: readonly string[];
  /** Every terminal the fake currently holds, live and finished, in address order. */
  terminals(): readonly HcTerminal[];
}

/**
 * Build the deterministic port. In-memory unless `statePath` is given, in which case terminals,
 * labels, addresses, and the creation ledger survive the process (a restart adopts, never
 * duplicates).
 */
export function createFakeHcPort(options: FakeHcPortOptions = {}): FakeHc {
  const templates = options.templates ?? FAKE_HC_TEMPLATES;
  const version = options.version ?? FAKE_HC_VERSION;
  const env = options.env ?? process.env;
  const blockStep = options.blockStep ?? env["ARGOS_FAKE_HC_BLOCK_STEP"];
  const releaseFile = options.releaseFile ?? env["ARGOS_FAKE_HC_RELEASE_FILE"];
  const completeAfterPolls = options.completeAfterPolls ?? 1;
  const store = options.statePath === undefined ? undefined : createFileState(options.statePath);

  const terminals = new Map<string, StoredTerminal>();
  const polls = new Map<string, number>();
  const sends: HcSendInput[] = [];
  const removes: string[] = [];
  const kills: string[] = [];
  let nextAddress = 1;
  let loaded = false;

  const register = (terminal: StoredTerminal): void => {
    terminals.set(terminal.address, terminal);
    const numeric = Number.parseInt(terminal.address.replace(/^t/, ""), 10);
    if (Number.isInteger(numeric) && numeric >= nextAddress) nextAddress = numeric + 1;
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (store === undefined) return;
    const persisted = store.load();
    for (const terminal of persisted.terminals) register(terminal);
    nextAddress = Math.max(nextAddress, persisted.nextAddress);
  };

  const persist = (): void => {
    if (store === undefined) return;
    store.save([...terminals.values()], nextAddress);
  };

  const lookup = (addressOrName: string): StoredTerminal | undefined => {
    load();
    const byAddress = terminals.get(addressOrName);
    if (byAddress !== undefined) return byAddress;
    // hc accepts a name wherever it accepts an address; keep that true here too.
    return [...terminals.values()].find((terminal) => terminal.name === addressOrName);
  };

  const require = (addressOrName: string, method: string): StoredTerminal => {
    const terminal = lookup(addressOrName);
    if (terminal === undefined) throw new HcKindError("not_found", method);
    return terminal;
  };

  /** Test-only hold: that step's terminal reports `working` until the release file appears. */
  const held = (terminal: StoredTerminal): boolean => {
    if (blockStep === undefined || terminal.labels["argos/step"] !== blockStep) return false;
    return releaseFile === undefined || !existsSync(releaseFile);
  };

  /** FR23's terminal poll: the program exits with code 0 once its polls run out. */
  const settle = (terminal: StoredTerminal): void => {
    if (terminal.state === "finished") return;
    if (held(terminal)) return;
    const count = (polls.get(terminal.address) ?? 0) + 1;
    if (count < completeAfterPolls) {
      polls.set(terminal.address, count);
      return;
    }
    terminal.state = "finished";
    terminal.statusWord = null;
    terminal.exit_code = 0;
    terminal.signal = null;
    terminal.reason = "exited";
    terminal.finished_ms = Date.now();
    terminal.text = FAKE_HC_RESULT_TEXT;
    terminal.turn = Math.max(terminal.turn, 1);
    persist();
  };

  const create = (input: HcRunInput, template: string | null): StoredTerminal => {
    load();
    const address = `t${nextAddress}`;
    nextAddress += 1;
    const at = Date.now();
    const terminal: StoredTerminal = {
      address,
      name: input.name ?? address,
      labels: { ...(input.labels ?? {}) },
      argv: [...input.argv],
      cwd: input.cwd ?? "",
      template,
      state: "live",
      statusWord: "working",
      turn: 0,
      exit_code: null,
      signal: null,
      reason: null,
      created_ms: at,
      finished_ms: null,
      text: "",
      reported: true,
      // A template's first message is its `argv` task, which hc accepted: nothing to type later.
      first_message:
        template === null ? null : { sent: true, started: true, turn: 0, reason: null },
    };
    const launch: FakeHcLaunch = {
      requestId: terminal.labels["argos/launch"] ?? "",
      stepId: terminal.labels["argos/step"] ?? "",
      attempt: attemptOf(terminal),
      name: terminal.name,
      address,
      template,
      at,
      pid: process.pid,
    };
    // Append first (the crash-proof creation evidence), then rewrite the readable snapshot.
    store?.append(launch);
    register(terminal);
    persist();
    return terminal;
  };

  const port: FakeHc = {
    templateNames: templates,
    sends,
    removes,
    kills,

    terminals(): readonly HcTerminal[] {
      load();
      return [...terminals.values()].map((terminal) => toTerminal(terminal));
    },

    async hello(): Promise<HcHello> {
      return {
        generation: HC_PROTOCOL_GENERATION,
        version,
        core: { ...DEFAULT_CORE },
        framed: false,
        methods: [
          "hello",
          "server.status",
          "templates.list",
          "terminal.run",
          "terminal.get",
          "terminal.list",
          "terminal.send",
          "terminal.read",
          "terminal.kill",
          "terminal.rm",
        ],
        features: ["status"],
      };
    },

    async serverStatus(): Promise<HcServerStatus> {
      load();
      const all = [...terminals.values()];
      return {
        core: { ...DEFAULT_CORE },
        pid: process.pid,
        version,
        uptimeMs: 0,
        live: all.filter((terminal) => terminal.state === "live").length,
        finished: all.filter((terminal) => terminal.state === "finished").length,
      };
    },

    async templatesList(): Promise<HcTemplate[]> {
      return templates.map((name) => ({
        name,
        description: `${name} template`,
        command: name,
        error: null,
      }));
    },

    async runTerminal(input: HcRunInput): Promise<HcRunResult> {
      load();
      const name = input.name;
      if (name !== undefined && name.length > 0) {
        const clash = [...terminals.values()].find(
          (terminal) => terminal.name === name && terminal.state === "live",
        );
        // hc keeps names unique among live terminals; a taken one is an adoption for the adapter.
        if (clash !== undefined) throw new HcKindError("name_taken", "terminal.run");
      }
      const first = input.argv[0];
      const template = first !== undefined && templates.includes(first) ? first : null;
      const terminal = create(input, template);
      return { ...toTerminal(terminal), output: null };
    },

    async getTerminal(terminal: string): Promise<HcTerminal> {
      const stored = require(terminal, "terminal.get");
      settle(stored);
      return toTerminal(stored);
    },

    async listTerminals(options: HcListOptions = {}): Promise<HcTerminal[]> {
      load();
      const labels = options.labels ?? {};
      return [...terminals.values()]
        .filter((terminal) => options.all === true || terminal.state === "live")
        .filter((terminal) =>
          Object.entries(labels).every(([key, value]) => terminal.labels[key] === value),
        )
        .map((terminal) => toTerminal(terminal));
    },

    async sendText(input: HcSendInput): Promise<HcSendResult> {
      const stored = require(input.terminal, "terminal.send");
      if (stored.state === "finished") throw new HcKindError("finished", "terminal.send");
      if (input.if !== undefined && stored.statusWord !== input.if) {
        throw new HcKindError("status_mismatch", "terminal.send");
      }
      if (stored.statusWord === "blocked" && input.force !== true) {
        throw new HcKindError("blocked", "terminal.send");
      }
      sends.push({ ...input });
      // A delivered message is no longer "unsent": the durable fact FR20 derives exactly-once
      // prompt delivery from, so a later poll must not type the same prompt again.
      if (stored.first_message !== null) {
        stored.first_message = { ...stored.first_message, sent: true };
        persist();
      }
      return {
        turn: stored.turn,
        status: stored.statusWord,
        started: stored.statusWord === "working",
      };
    },

    async readTerminal(terminal: string, options: HcReadOptions = {}): Promise<HcReadResult> {
      const stored = require(terminal, "terminal.read");
      return {
        text: stored.text,
        complete: true,
        how: options.lines === undefined ? "screen" : "history",
        why: null,
      };
    },

    async killTerminal(terminal: string): Promise<HcKillResult> {
      const stored = require(terminal, "terminal.kill");
      if (stored.state === "finished") throw new HcKindError("finished", "terminal.kill");
      kills.push(stored.address);
      // hc: the program is signalled; the terminal stays until `terminal.rm` collects it.
      stored.state = "finished";
      stored.statusWord = null;
      stored.exit_code = null;
      stored.signal = 15;
      stored.reason = "killed";
      stored.finished_ms = Date.now();
      persist();
      return { killed: stored.address };
    },

    async removeTerminal(terminal: string): Promise<HcRemoveResult> {
      const stored = require(terminal, "terminal.rm");
      // hc refuses to remove a live terminal; the adapter kills first (FR26).
      if (stored.state === "live") throw new HcKindError("live", "terminal.rm");
      removes.push(stored.address);
      terminals.delete(stored.address);
      polls.delete(stored.address);
      persist();
      return { removed: stored.address };
    },
  };
  return port;
}


