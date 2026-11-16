/**
 * In-memory `HcPort` for the `hc` adapter tests (Phase 5/6).
 *
 * It models only what the adapter may rely on: named terminals in a map, the program's own status
 * word, turns, exit code/signal, template first messages, and label filtering. No socket, no
 * timers, no retries — every transition is an explicit test call, so a test can assert exact
 * `run`/`send`/`read`/`remove` counts.
 *
 * The two facts that make the adapter's crash story testable are modelled exactly:
 * `terminal.run` returns `first_message.sent` (so a test can force the later `terminal.send`), and
 * a name that already exists fails with `name_taken` (so a test can force adoption). `forget()`
 * removes a terminal without recording a `terminal.rm`, which is how a "lost terminal" — the
 * handover path (FR24) — is simulated.
 */

import {
  HcKindError,
  HcTransportError,
  type HcCoreInfo,
  type HcErrorKind,
  type HcFirstMessage,
  type HcHello,
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
} from "../../src/hc/port.js";

/** The wire method names, so an injected failure names the call it belongs to. */
export type FakeHcMethod =
  | "hello"
  | "server.status"
  | "templates.list"
  | "terminal.run"
  | "terminal.get"
  | "terminal.list"
  | "terminal.send"
  | "terminal.read"
  | "terminal.rm";

export interface FakeHcOptions {
  /** Template names (the catalog `hc/<name>` targets come from). */
  readonly templates?: readonly string[];
  readonly version?: string;
  /** Protocol generation the fake core reports; default 1. */
  readonly generation?: number;
  readonly core?: HcCoreInfo;
  /** Every call throws `HcTransportError` (settable later through `unreachable`). */
  readonly unreachable?: boolean;
  /** Status word a new terminal starts with; `null` models a program that never reports. */
  readonly initialStatus?: string | null;
  /** Names that already exist on the core: `terminal.run` fails `name_taken`. */
  readonly takenNames?: readonly string[];
  /** Message a `blocked` first status carries (FR22 detail). */
  readonly blockedMessage?: string | null;
  /** Whether a template run's first message goes in (FR20); default `true`. */
  readonly firstMessageSent?: boolean;
  /** Deterministic clock for `created_ms`/`finished_ms`. */
  readonly now?: () => number;
}

/** One `terminal.run` the fake accepted (the creation ledger: one terminal per attempt). */
export interface FakeHcRun extends HcRunInput {
  readonly address: string;
  readonly template: string | null;
  readonly firstMessageSent: boolean;
}

interface StoredTerminal {
  address: string;
  name: string;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  template: string | null;
  state: "live" | "finished";
  status: HcTerminalStatus | null;
  turn: number;
  exit_code: number | null;
  signal: number | null;
  reason: string | null;
  created_ms: number;
  finished_ms: number | null;
  text: string;
  reported: boolean;
  first_message: HcFirstMessage | null;
  polls: number;
}

const DEFAULT_CORE: HcCoreInfo = { id: "fake-core", name: "fake-host" };

/** The path a fake core would live at (the adapter only ever sees it in error text). */
const FAKE_SOCKET = "/fake/herdr-core/default/default.sock";

function statusWord(status: HcTerminalStatus | null): string | null {
  return status === null ? null : status.state;
}

function toTerminal(stored: StoredTerminal): HcTerminal {
  return {
    address: stored.address,
    name: stored.name,
    state: stored.state,
    status: stored.status === null ? null : { ...stored.status },
    turn: stored.turn,
    exit_code: stored.exit_code,
    signal: stored.signal,
    reason: stored.reason,
    labels: { ...stored.labels },
    argv: [...stored.argv],
    cwd: stored.cwd,
    pid: stored.state === "finished" ? null : 1000 + Number(stored.address.replace("t", "")),
    created_ms: stored.created_ms,
    finished_ms: stored.finished_ms,
    screen: "exact",
    title: stored.status?.title ?? "",
    reported: stored.reported,
    template: stored.template,
    first_message: stored.first_message === null ? null : { ...stored.first_message },
  };
}

export class FakeHcPort implements HcPort {
  readonly templates: readonly string[];
  readonly generation: number;
  readonly version: string;
  readonly core: HcCoreInfo;
  /** Settable at any time: every following call fails as an unreachable core. */
  unreachable: boolean;
  /** Every accepted `terminal.run`, in order (the creation ledger). */
  readonly runs: FakeHcRun[] = [];
  /** Every `terminal.run` invocation by name, including `name_taken` rejections. */
  readonly runCalls: string[] = [];
  /** Every delivered message (FR20: exactly one per turn). */
  readonly sends: HcSendInput[] = [];
  readonly reads: string[] = [];
  readonly removes: string[] = [];
  readonly gets: string[] = [];
  readonly lists: HcListOptions[] = [];
  helloCalls = 0;
  statusCalls = 0;
  templateCalls = 0;

  readonly #terminals = new Map<string, StoredTerminal>();
  readonly #takenNames = new Set<string>();
  readonly #failures = new Map<FakeHcMethod, HcErrorKind[]>();
  readonly #initialStatus: string | null;
  readonly #blockedMessage: string | null;
  readonly #firstMessageSent: boolean;
  readonly #now: () => number;
  #nextAddress = 1;

  constructor(options: FakeHcOptions = {}) {
    this.templates = options.templates ?? ["claude", "codex"];
    this.generation = options.generation ?? 1;
    this.version = options.version ?? "0.1.21";
    this.core = options.core ?? DEFAULT_CORE;
    this.unreachable = options.unreachable ?? false;
    this.#initialStatus = options.initialStatus === undefined ? "working" : options.initialStatus;
    this.#blockedMessage = options.blockedMessage ?? null;
    this.#firstMessageSent = options.firstMessageSent ?? true;
    this.#now = options.now ?? (() => 1_700_000_000_000);
    for (const name of options.takenNames ?? []) this.#takenNames.add(name);
  }

  // ---------------------------------------------------------------- test controls

  /** Seed a terminal the core already has (e.g. created before a simulated crash). */
  seedTerminal(input: {
    readonly name: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly argv?: readonly string[];
    readonly cwd?: string;
    readonly template?: string | null;
    readonly status?: string | null;
    readonly turn?: number;
    readonly firstMessageSent?: boolean;
    readonly text?: string;
  }): string {
    return this.#create(input.name, {
      labels: input.labels ?? {},
      argv: input.argv ?? [],
      cwd: input.cwd ?? "/tmp",
      template: input.template ?? null,
      status: input.status === undefined ? this.#initialStatus : input.status,
      firstMessageSent: input.firstMessageSent ?? this.#firstMessageSent,
      text: input.text ?? "",
    }).address;
  }

  /** Report a status word, as the program would through OSC 7501. */
  reportStatus(
    address: string,
    input: {
      readonly state: string;
      readonly msg?: string;
      readonly title?: string;
      readonly kind?: string;
      readonly progress?: number;
    },
  ): void {
    const terminal = this.#require(address, "terminal.get");
    const wasWorking = statusWord(terminal.status) === "working";
    terminal.status = {
      state: input.state,
      msg: input.msg ?? null,
      title: input.title ?? null,
      kind: input.kind ?? null,
      progress: input.progress ?? null,
    };
    terminal.reported = true;
    // hc: the turn goes up each time the status leaves `working`.
    if (wasWorking && input.state !== "working") terminal.turn += 1;
  }

  /** Finish a terminal with an exit code, signal, and/or final text. */
  finishTerminal(
    address: string,
    input: {
      readonly exitCode?: number | null;
      readonly signal?: number | null;
      readonly reason?: string;
      readonly text?: string;
    } = {},
  ): void {
    const terminal = this.#require(address, "terminal.get");
    terminal.state = "finished";
    terminal.status = null;
    terminal.exit_code = input.exitCode ?? null;
    terminal.signal = input.signal ?? null;
    terminal.reason = input.reason ?? "exited";
    terminal.finished_ms = this.#now();
    if (input.text !== undefined) terminal.text = input.text;
  }

  /** Append to the terminal's readable text (the `terminal.read` payload). */
  appendText(address: string, text: string): void {
    const terminal = this.#require(address, "terminal.get");
    terminal.text += text;
  }

  /** Set an exact turn (the adapter's "nothing was submitted" test: `turn === 0`). */
  setTurn(address: string, turn: number): void {
    this.#require(address, "terminal.get").turn = turn;
  }

  /** The terminal disappeared (lost, core restarted): later calls are `not_found`, no `rm`. */
  forget(address: string): void {
    const terminal = this.#lookup(address);
    if (terminal === undefined) return;
    this.#terminals.delete(terminal.address);
  }

  /** Make the next `times` calls to `method` fail with `kind` (FR24/FR26 paths). */
  failNext(method: FakeHcMethod, kind: HcErrorKind, times = 1): void {
    const queue = this.#failures.get(method) ?? [];
    for (let index = 0; index < times; index += 1) queue.push(kind);
    this.#failures.set(method, queue);
  }

  /** The latest `terminal.run` for one name, if any. */
  runFor(name: string): FakeHcRun | undefined {
    return [...this.runs].reverse().find((run) => run.name === name);
  }

  /** How many `terminal.run` calls named this terminal (accepted or `name_taken`). */
  runsFor(name: string): number {
    return this.runCalls.filter((call) => call === name).length;
  }

  /** The seeded/created terminal behind one address or name. */
  terminalFor(address: string): HcTerminal | undefined {
    const stored = this.#lookup(address);
    return stored === undefined ? undefined : toTerminal(stored);
  }

  /** Live terminals, in creation order. */
  liveTerminals(): HcTerminal[] {
    return [...this.#terminals.values()]
      .filter((terminal) => terminal.state === "live")
      .map((terminal) => toTerminal(terminal));
  }

  // ---------------------------------------------------------------- HcPort

  async hello(): Promise<HcHello> {
    this.helloCalls += 1;
    this.#assertReachable();
    this.#throwInjected("hello");
    return {
      generation: this.generation,
      version: this.version,
      core: { ...this.core },
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
        "terminal.rm",
      ],
      features: ["status"],
    };
  }

  async serverStatus(): Promise<HcServerStatus> {
    this.statusCalls += 1;
    this.#assertReachable();
    this.#throwInjected("server.status");
    const terminals = [...this.#terminals.values()];
    return {
      core: { ...this.core },
      pid: 4242,
      version: this.version,
      uptimeMs: 60_000,
      live: terminals.filter((terminal) => terminal.state === "live").length,
      finished: terminals.filter((terminal) => terminal.state === "finished").length,
    };
  }

  async templatesList(): Promise<HcTemplate[]> {
    this.templateCalls += 1;
    this.#assertReachable();
    this.#throwInjected("templates.list");
    return this.templates.map((name) => ({
      name,
      description: `${name} template`,
      command: name,
      error: null,
    }));
  }

  async runTerminal(input: HcRunInput): Promise<HcRunResult> {
    const name = input.name ?? "";
    this.runCalls.push(name);
    this.#assertReachable();
    this.#throwInjected("terminal.run");
    if (name.length > 0 && (this.#takenNames.has(name) || this.#liveByName(name) !== undefined)) {
      throw new HcKindError("name_taken", "terminal.run");
    }
    const template = input.argv[0] !== undefined && this.templates.includes(input.argv[0])
      ? input.argv[0]
      : null;
    const terminal = this.#create(name, {
      labels: input.labels ?? {},
      argv: input.argv,
      cwd: input.cwd ?? "/tmp",
      template,
      status: this.#initialStatus,
      firstMessageSent: template === null ? false : this.#firstMessageSent,
      text: "",
    });
    this.runs.push({
      ...input,
      address: terminal.address,
      template,
      firstMessageSent: template !== null && this.#firstMessageSent,
    });
    return { ...toTerminal(terminal), output: null };
  }

  async getTerminal(terminal: string): Promise<HcTerminal> {
    this.gets.push(terminal);
    this.#assertReachable();
    this.#throwInjected("terminal.get");
    const stored = this.#require(terminal, "terminal.get");
    stored.polls += 1;
    return toTerminal(stored);
  }

  async listTerminals(options: HcListOptions = {}): Promise<HcTerminal[]> {
    this.lists.push(options);
    this.#assertReachable();
    this.#throwInjected("terminal.list");
    const labels = options.labels ?? {};
    return [...this.#terminals.values()]
      .filter((terminal) => options.all === true || terminal.state === "live")
      .filter((terminal) =>
        Object.entries(labels).every(([key, value]) => terminal.labels[key] === value),
      )
      .map((terminal) => toTerminal(terminal));
  }

  async sendText(input: HcSendInput): Promise<HcSendResult> {
    this.#assertReachable();
    this.#throwInjected("terminal.send");
    const terminal = this.#require(input.terminal, "terminal.send");
    if (terminal.state === "finished") throw new HcKindError("finished", "terminal.send");
    const word = statusWord(terminal.status);
    if (input.if !== undefined && word !== input.if) {
      throw new HcKindError("status_mismatch", "terminal.send");
    }
    if (word === "blocked" && input.force !== true) {
      throw new HcKindError("blocked", "terminal.send");
    }
    this.sends.push({ ...input });
    if (word === "idle") {
      terminal.status = {
        state: "working",
        msg: null,
        title: terminal.status?.title ?? null,
        kind: null,
        progress: null,
      };
      terminal.reported = true;
    }
    return {
      turn: terminal.turn,
      status: statusWord(terminal.status),
      started: terminal.status === null ? null : statusWord(terminal.status) === "working",
    };
  }

  async readTerminal(terminal: string, options: HcReadOptions = {}): Promise<HcReadResult> {
    this.reads.push(terminal);
    this.#assertReachable();
    this.#throwInjected("terminal.read");
    const stored = this.#require(terminal, "terminal.read");
    return {
      text: stored.text,
      complete: true,
      how: options.lines === undefined ? "screen" : "history",
      why: null,
    };
  }

  async removeTerminal(terminal: string): Promise<HcRemoveResult> {
    this.#assertReachable();
    this.#throwInjected("terminal.rm");
    const stored = this.#require(terminal, "terminal.rm");
    if (stored.state === "live") throw new HcKindError("live", "terminal.rm");
    this.removes.push(stored.address);
    this.#terminals.delete(stored.address);
    return { removed: stored.address };
  }

  // ---------------------------------------------------------------- internals

  #create(
    name: string,
    input: {
      readonly labels: Readonly<Record<string, string>>;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly template: string | null;
      readonly status: string | null;
      readonly firstMessageSent: boolean;
      readonly text: string;
    },
  ): StoredTerminal {
    const address = `t${this.#nextAddress}`;
    this.#nextAddress += 1;
    const terminal: StoredTerminal = {
      address,
      name,
      labels: { ...input.labels },
      argv: [...input.argv],
      cwd: input.cwd,
      template: input.template,
      state: "live",
      status:
        input.status === null
          ? null
          : {
              state: input.status,
              msg: input.status === "blocked" ? this.#blockedMessage : null,
              title: null,
              kind: input.status === "blocked" ? "question" : null,
              progress: null,
            },
      turn: 0,
      exit_code: null,
      signal: null,
      reason: null,
      created_ms: this.#now(),
      finished_ms: null,
      text: input.text,
      reported: input.status !== null,
      first_message:
        input.template === null
          ? null
          : { sent: input.firstMessageSent, started: null, turn: null, reason: null },
      polls: 0,
    };
    this.#terminals.set(address, terminal);
    return terminal;
  }

  #lookup(addressOrName: string): StoredTerminal | undefined {
    const byAddress = this.#terminals.get(addressOrName);
    if (byAddress !== undefined) return byAddress;
    // hc accepts a name wherever it accepts an address; keep that true here too.
    return [...this.#terminals.values()].find((terminal) => terminal.name === addressOrName);
  }

  #liveByName(name: string): StoredTerminal | undefined {
    const terminal = this.#lookup(name);
    return terminal !== undefined && terminal.state === "live" ? terminal : undefined;
  }

  #require(addressOrName: string, method: string): StoredTerminal {
    const terminal = this.#lookup(addressOrName);
    if (terminal === undefined) throw new HcKindError("not_found", method);
    return terminal;
  }

  #assertReachable(): void {
    if (!this.unreachable) return;
    throw new HcTransportError(`cannot reach the herdr-core core at ${FAKE_SOCKET}`, {
      socket: FAKE_SOCKET,
    });
  }

  #throwInjected(method: FakeHcMethod): void {
    const queue = this.#failures.get(method);
    if (queue === undefined || queue.length === 0) return;
    const kind = queue.shift();
    if (kind === undefined) return;
    throw new HcKindError(kind, method);
  }
}
