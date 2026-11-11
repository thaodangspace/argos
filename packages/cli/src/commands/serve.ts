/**
 * `argos serve` (FR2/FR25) — the **only** process that opens `$ARGOS_HOME/argos.sqlite`.
 *
 * It builds the Paseo executor (or the deterministic `ARGOS_FAKE_PASEO=1` test executor), opens
 * `ArgosHost` (pid file + SQLite + `resume()`), ensures the bearer token, starts the loopback RPC
 * server, and waits for SIGINT/SIGTERM to close both gracefully. The host is retried once on a
 * transient open failure; `storage_locked` is never retried because another live process owns the
 * home.
 */

import { resolve } from "node:path";

import { argosHome, isArgosError } from "argos-core";
import {
  ArgosHost,
  createRpcServer,
  type ArgosHostOptions,
} from "argos-core/rpc/server";
import {
  ModelCatalog,
  createAgentStepExecutor,
  createFakeStepExecutor,
  createPaseoPort,
  fakeProviderCatalog,
  type PaseoClientPort,
} from "argos-core/paseo";
import type { PaseoProbe } from "argos-core/rpc/server";

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import {
  EXIT_RUNTIME,
  REQUIRED_NODE_VERSION,
  nodeVersionOk,
  type CliIo,
} from "../output.js";

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
    if (isArgosError(error) && error.code === "storage_locked") throw error;
    await delay(250);
    return ArgosHost.open(options);
  }
}

interface Dependencies {
  readonly host: ArgosHost;
  readonly probe: PaseoProbe;
  readonly close: () => Promise<void>;
}

async function buildDependencies(home: string, io: CliIo): Promise<Dependencies> {
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
    });
    return {
      host,
      probe: { mode: "fake", snapshot: async () => fakeProviderCatalog() },
      close: async () => undefined,
    };
  }

  const paseo: PaseoClientPort = createPaseoPort();
  let catalog: ModelCatalog | undefined;
  try {
    catalog = await within(ModelCatalog.load(paseo), 5_000);
  } catch (error) {
    io.stderr(
      `[argos] warning: could not load the provider catalog (${error instanceof Error ? error.message : String(error)}); runs will fail until the daemon is reachable\n`,
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
  });
  return {
    host,
    probe: {
      url: paseo.url,
      mode: "live",
      snapshot: () => paseo.providersSnapshot(),
    },
    close: () => paseo.close(),
  };
}

export async function serveCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["port", "home"]);
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

  let dependencies: Dependencies | undefined;
  try {
    dependencies = await buildDependencies(home, io);
    const server = await createRpcServer({
      host: dependencies.host,
      home,
      port,
      cwd: process.cwd(),
      paseo: dependencies.probe,
    });

    if (args.json) {
      io.stdout(
        `${JSON.stringify({ port: server.port, home, pid: process.pid })}\n`,
      );
    } else {
      io.stdout(`[argos] listening on ${server.url} (home ${home}, pid ${process.pid})\n`);
    }

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
