/**
 * `argos serve` (FR2/FR25) — the **only** process that opens `$ARGOS_HOME/argos.sqlite`.
 *
 * It builds the executor registry (`paseo` always, `hc` when a real herdr-core answers inside the
 * 5 s probe or when the test-only `ARGOS_FAKE_EXECUTOR=hc` selects the deterministic fake), opens
 * `ArgosHost` (pid file + SQLite + `resume()`), ensures the bearer token, starts the loopback RPC
 * server, prints one stderr line naming the registry, and waits for SIGINT/SIGTERM to close both
 * gracefully. The host is retried once on a transient open failure; `storage_locked` and
 * `executor_unavailable` are never retried because another live process owns the home and a
 * missing adapter does not appear by waiting.
 */

import { resolve } from "node:path";

import { argosHome, isArgosError } from "@thaodangspace/argos-core";
import {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_IDS,
  executorIdFor,
  type ExecutorId,
  type ExecutorInfo,
} from "@thaodangspace/argos-core/rpc";
import {
  ArgosHost,
  createRpcServer,
  type ArgosHostOptions,
} from "@thaodangspace/argos-core/rpc/server";
import {
  ModelCatalog,
  createAgentStepExecutor,
  createFakeStepExecutor,
  createPaseoPort,
  fakeProviderCatalog,
  type PaseoClientPort,
} from "@thaodangspace/argos-core/paseo";
import {
  FAKE_HC_VERSION,
  HC_PROTOCOL_GENERATION,
  HcCatalog,
  createFakeHcPort,
  createHcClient,
  createHcStepExecutor,
} from "@thaodangspace/argos-core/hc";
import type { PaseoProbe } from "@thaodangspace/argos-core/rpc/server";

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { inspectUi, resolveUiDir } from "../ui-dir.js";
import {
  EXIT_RUNTIME,
  REQUIRED_NODE_VERSION,
  nodeVersionOk,
  type CliIo,
} from "../output.js";

/**
 * FR10.4: one fire outcome, as `ArgosHost.observeScheduleFires` announces it. Derived from the host
 * method so the CLI never imports `@thaodangspace/argos-core/durable` (the import-graph guard forbids it).
 */
type ScheduleFireListener = Parameters<ArgosHost["observeScheduleFires"]>[0];
export type ScheduleFireEvent = Parameters<ScheduleFireListener>[0];

/**
 * The single stderr line `argos serve` prints per fire (FR10.4), including its newline.
 *
 * It carries the schedule id, the ISO fire time, the status, and then either the run the fire
 * started or the error code that refused it. It never contains an input value — and the event it
 * reads has no inputs at all.
 */
export function formatScheduleFireLine(event: ScheduleFireEvent): string {
  const head = `[argos] schedule ${event.scheduleId} ${new Date(event.fireAt).toISOString()} ${event.status}`;
  const tail =
    event.runId !== undefined
      ? ` run ${event.runId}`
      : event.errorCode !== undefined && event.errorCode !== null
        ? ` ${event.errorCode}`
        : event.count !== undefined
          ? ` ${event.count}`
          : "";
  return `${head}${tail}\n`;
}

/**
 * FR9/NFR: the one stderr line `argos serve` prints at startup listing the registry, e.g.
 * `[argos] executors: paseo (default), hc`. Ids only — never a path, a token, or an input value.
 */
export function formatExecutorLine(executors: readonly ExecutorInfo[]): string {
  const listed = executors.map((executor) => (executor.default ? `${executor.id} (default)` : executor.id));
  return `[argos] executors: ${listed.length === 0 ? "(none)" : listed.join(", ")}\n`;
}

function configuredPort(value: string | undefined): number {
  const raw = value ?? process.env["ARGOS_PORT"];
  if (raw === undefined) return 7676;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 7676;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Bound startup catalog discovery so a down daemon cannot block `argos serve`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Open once, then once more after a short pause unless the home is owned by a live process. */
async function openHost(options: ArgosHostOptions): Promise<ArgosHost> {
  try {
    return await ArgosHost.open(options);
  } catch (error) {
    // Neither an owned home nor an unusable default executor gets better by trying again: both are
    // decided before anything is opened/created, and a retry would only delay the same refusal.
    if (isArgosError(error) && (error.code === "storage_locked" || error.code === "executor_unavailable")) {
      throw error;
    }
    await delay(250);
    return ArgosHost.open(options);
  }
}

interface Dependencies {
  readonly host: ArgosHost;
  readonly probe: PaseoProbe;
  readonly close: () => Promise<void>;
}

/** FR9: the same 5 s bound the provider catalog uses, so a down core never blocks startup. */
const HC_PROBE_TIMEOUT_MS = 5_000;

/** FR9: what `argos serve` needs from one `hc` registration. */
interface HcRegistration {
  readonly executor: ArgosHostOptions["executor"];
  readonly catalog: HcCatalog;
  /** FR9: the reachability/version the registry publishes (`GET /info`, `argos doctor`). */
  readonly info: { readonly reachable: boolean; readonly version?: string; readonly error?: string };
  readonly close: () => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * FR9/FR16: the `hc` half of the executor registry.
 *
 * - `ARGOS_FAKE_EXECUTOR=hc` (test only) registers the deterministic fake port, file-backed under
 *   `ARGOS_FAKE_HC_DIR` (else `$ARGOS_HOME`) so a restarted `argos serve` adopts the terminals its
 *   predecessor created. No socket is opened and no real core is probed.
 * - Otherwise a real core is probed inside {@link HC_PROBE_TIMEOUT_MS}: `hello` (protocol
 *   generation 1) then `server.status`, then `templates.list` for the `hc/<template>` catalog. A
 *   down/incompatible/missing core is a **warning**, never a startup failure: the registry simply
 *   does not advertise `hc`, and every other substrate keeps working.
 *
 * With `ARGOS_FAKE_PASEO=1` and no `ARGOS_FAKE_EXECUTOR`, `hc` is deliberately absent: a test-only
 * server must not depend on whatever core happens to run on the machine.
 */
async function buildHcRegistration(
  home: string,
  io: CliIo,
): Promise<HcRegistration | undefined> {
  if (process.env["ARGOS_FAKE_EXECUTOR"] === "hc") {
    io.stderr(
      "[argos] ARGOS_FAKE_EXECUTOR=hc: using the deterministic herdr-core test executor\n",
    );
    const fakeDir = process.env["ARGOS_FAKE_HC_DIR"];
    const port = createFakeHcPort({ statePath: resolve(fakeDir ?? home) });
    const catalog = HcCatalog.fromTemplates(await port.templatesList());
    return {
      executor: createHcStepExecutor({ port, catalog, home }),
      catalog,
      info: { reachable: true, version: FAKE_HC_VERSION },
      close: async () => undefined,
    };
  }
  if (process.env["ARGOS_FAKE_PASEO"] === "1") return undefined;

  const client = createHcClient();
  try {
    const hello = await within(client.hello(), HC_PROBE_TIMEOUT_MS);
    if (hello.generation !== HC_PROTOCOL_GENERATION) {
      throw new Error(
        `the core speaks protocol generation ${hello.generation}; Argos needs ${HC_PROTOCOL_GENERATION}`,
      );
    }
    const status = await within(client.serverStatus(), HC_PROBE_TIMEOUT_MS);
    const catalog = await within(HcCatalog.load(client), HC_PROBE_TIMEOUT_MS);
    return {
      executor: createHcStepExecutor({ port: client, catalog, home }),
      catalog,
      info: {
        reachable: true,
        ...(status.version.length === 0 ? {} : { version: status.version }),
      },
      close: () => client.close(),
    };
  } catch (error) {
    io.stderr(
      `[argos] warning: herdr-core is not available (${errorText(error)}); the hc executor is not registered\n`,
    );
    await client.close().catch(() => undefined);
    return undefined;
  }
}

async function buildDependencies(
  home: string,
  io: CliIo,
  defaultExecutor: ExecutorId,
): Promise<Dependencies> {
  const hc = await buildHcRegistration(home, io);
  // The registry additions of a registered `hc`: its executor, its template catalog, and the
  // reachability `/info` reports. `paseo` stays `options.executor` and its own catalog option, so
  // the two descriptors must be **merged**, not spread over each other.
  const hcExecutors: NonNullable<ArgosHostOptions["executors"]> =
    hc === undefined ? {} : { hc: hc.executor };
  const hcCatalogs: NonNullable<ArgosHostOptions["catalogs"]> =
    hc === undefined ? {} : { hc: hc.catalog };
  const hcInfo: NonNullable<ArgosHostOptions["executorInfo"]> =
    hc === undefined ? {} : { hc: hc.info };
  const closeHc = hc === undefined ? async (): Promise<void> => undefined : hc.close;

  try {
    if (process.env["ARGOS_FAKE_PASEO"] === "1") {
      io.stderr("[argos] ARGOS_FAKE_PASEO=1: using the deterministic test-only executor\n");
      const catalog = ModelCatalog.fromSnapshot(fakeProviderCatalog());
      // File-backed by default so a restarted `argos serve` adopts the fake agents it created in
      // its previous lifetime (Phase 10 D17). `ARGOS_FAKE_PASEO_DIR` moves the state elsewhere.
      const fakeDir = process.env["ARGOS_FAKE_PASEO_DIR"];
      const host = await openHost({
        home,
        executor: createFakeStepExecutor({
          statePath: fakeDir === undefined ? home : resolve(fakeDir),
        }),
        modelCatalog: catalog,
        defaultExecutor,
        executorInfo: { paseo: { reachable: true }, ...hcInfo },
        executors: hcExecutors,
        catalogs: hcCatalogs,
        // FR10.4: registered before the first tick, so a catch-up fire during `open()` still prints.
        onScheduleFire: (event) => io.stderr(formatScheduleFireLine(event)),
      });
      return {
        host,
        probe: { mode: "fake", snapshot: async () => fakeProviderCatalog() },
        close: closeHc,
      };
    }

    const paseo: PaseoClientPort = createPaseoPort();
    let catalog: ModelCatalog | undefined;
    let catalogError: string | undefined;
    try {
      catalog = await within(ModelCatalog.load(paseo), HC_PROBE_TIMEOUT_MS);
    } catch (error) {
      catalogError = errorText(error);
      io.stderr(
        `[argos] warning: could not load the provider catalog (${catalogError}); runs will fail until the daemon is reachable\n`,
      );
    }
    const executor = createAgentStepExecutor({
      port: paseo,
      ...(catalog === undefined ? {} : { catalog }),
    });
    const host = await openHost({
      home,
      executor,
      ...(catalog === undefined ? {} : { modelCatalog: catalog }),
      defaultExecutor,
      // FR9: paseo's own reachability, so `argos doctor` can show every registered substrate.
      executorInfo: {
        paseo:
          catalog === undefined
            ? {
                reachable: false,
                error: "the Paseo provider catalog could not be loaded",
              }
            : { reachable: true },
        ...hcInfo,
      },
      executors: hcExecutors,
      catalogs: hcCatalogs,
      onScheduleFire: (event) => io.stderr(formatScheduleFireLine(event)),
    });
    return {
      host,
      probe: {
        url: paseo.url,
        mode: "live",
        snapshot: () => paseo.providersSnapshot(),
      },
      close: async () => {
        try {
          await paseo.close();
        } finally {
          await closeHc();
        }
      },
    };
  } catch (error) {
    // A failed open must not leak the hc socket this process already opened.
    await closeHc().catch(() => undefined);
    throw error;
  }
}

export async function serveCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["port", "home", "default-executor"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (!nodeVersionOk()) {
    io.stderr(
      `argos: Node ${process.versions.node} is too old; Argos needs ${REQUIRED_NODE_VERSION} (built-in SQLite)\n`,
    );
    return EXIT_RUNTIME;
  }
  const homeFlag = flag(args, "home");
  const home = resolve(homeFlag ?? argosHome());
  const portFlag = flag(args, "port");
  if (portFlag !== undefined && !/^\d+$/.test(portFlag)) {
    io.stderr("argos: --port must be a non-negative integer\n");
    return EXIT_RUNTIME;
  }
  const port = configuredPort(portFlag);

  // FR16: `--default-executor`, else `ARGOS_EXECUTOR`, else `paseo` (the flag wins). A value that is
  // not an executor at all is refused here, before anything is opened; a known id the registry does
  // not carry is refused by `ArgosHost.open` with `executor_unavailable`, naming the id and the
  // registered set. Either way no home, pid file, or database is touched.
  const executorValue = flag(args, "default-executor") ?? process.env["ARGOS_EXECUTOR"];
  const resolvedExecutor = executorValue === undefined ? DEFAULT_EXECUTOR_ID : executorIdFor(executorValue);
  if (resolvedExecutor === undefined) {
    io.stderr(
      `argos: --default-executor ${JSON.stringify(executorValue ?? "")} is unknown: use one of ${EXECUTOR_IDS.join(", ")}\n`,
    );
    return EXIT_RUNTIME;
  }
  const defaultExecutor: ExecutorId = resolvedExecutor;

  let dependencies: Dependencies | undefined;
  try {
    dependencies = await buildDependencies(home, io, defaultExecutor);
    // FR9/NFR Observability: one stderr line naming the registry and the default. `--json` keeps
    // stdout to its single receipt line, so this never disturbs the startup contract.
    io.stderr(formatExecutorLine(dependencies.host.executors));
    // Spec FR18: `ARGOS_UI_DIR` → the UI copied into the package. A configured directory that is
    // missing its shell is a warning (API-only), never a startup failure.
    const uiDir = resolveUiDir(process.env);
    const ui = inspectUi(uiDir);
    if (uiDir !== undefined && ui === undefined) {
      io.stderr(
        `[argos] warning: no UI at ${uiDir} (missing index.html); serving the API only\n`,
      );
    }
    const server = await createRpcServer({
      host: dependencies.host,
      home,
      port,
      cwd: process.cwd(),
      paseo: dependencies.probe,
      ...(ui === undefined ? {} : { ui: { dir: ui.dir } }),
    });
    if (ui !== undefined) {
      io.stderr(`[argos] ui ${ui.dir}${ui.buildId === undefined ? "" : ` (build ${ui.buildId})`}\n`);
    }

    if (args.json) {
      io.stdout(
        `${JSON.stringify({ port: server.port, home, pid: process.pid })}\n`,
      );
    } else {
      io.stdout(`[argos] listening on ${server.url} (home ${home}, pid ${process.pid})\n`);
    }

    // FR10.4: the fire line is already wired through `ArgosHost.open` (`onScheduleFire`), so a
    // catch-up fire that runs while the host opens is announced too. A JSON `serve` still keeps
    // stdout to one line.

    return await new Promise<number>((resolve) => {
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        void (async () => {
          try {
            await server.close();
          } finally {
            try {
              await dependencies?.host.close();
            } finally {
              await dependencies?.close().catch(() => undefined);
              resolve(0);
            }
          }
        })();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (error) {
    const code = isArgosError(error) ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : String(error);
    await dependencies?.host.close().catch(() => undefined);
    await dependencies?.close().catch(() => undefined);
    if (args.json) {
      io.stderr(`${JSON.stringify({ error: { code, message } })}\n`);
    } else {
      io.stderr(`argos: ${code}: ${message}\n`);
    }
    return EXIT_RUNTIME;
  }
}
