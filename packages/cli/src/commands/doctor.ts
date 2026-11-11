/**
 * `argos doctor` (FR25, NFR Observability) — works with and without a running server.
 *
 * Without a server it reports what it can read safely: the storage path and modes, the configured
 * port, the Node runtime check, and "not reachable" for the daemon. With a server it adds the live
 * `GET /info` view (schema version, actual port, pid, Paseo reachability, provider catalog, pending
 * gates, run counters). It **never** opens SQLite: the database is a `stat` at most.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { argosHome, dbPath } from "argos-core";
import {
  ARGOS_SCHEMA_VERSION,
  DEFAULT_ARGOS_PORT,
  RpcClient,
  RpcClientError,
  type DoctorCheck,
  type DoctorReport,
  type ServerInfo,
} from "argos-core/rpc";

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  REQUIRED_NODE_VERSION,
  nodeVersionOk,
  printJson,
  type CliIo,
} from "../output.js";

function configuredPort(value: string | undefined): number {
  const raw = value ?? process.env["ARGOS_PORT"];
  if (raw === undefined) return DEFAULT_ARGOS_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ARGOS_PORT;
}

function mode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function describeServer(report: DoctorReport): string {
  if (!report.server.reachable) return `${report.server.url} (not reachable)`;
  const pid = report.server.pid === undefined ? "" : `, pid ${report.server.pid}`;
  return `${report.server.url} (reachable${pid})`;
}

function describePaseo(report: DoctorReport): string {
  const modeLabel = report.paseo.mode === "fake" ? ", fake" : "";
  if (report.paseo.reachable) {
    return `${report.paseo.url ?? "default"} (reachable${modeLabel})`;
  }
  return report.paseo.error === undefined
    ? "not reachable"
    : `not reachable (${report.paseo.error})`;
}

function humanReport(report: DoctorReport): string {
  const homeMode = report.storage.homeMode === undefined ? "" : ` (${octal(report.storage.homeMode)})`;
  const dbMode =
    report.storage.dbMode === undefined ? " (not created yet)" : ` (${octal(report.storage.dbMode)})`;
  return [
    `argos doctor`,
    `  node       v${report.node.version} (requires ${report.node.required})`,
    `  home       ${report.home}${homeMode}`,
    `  storage    ${report.storage.path}${report.storage.exists ? dbMode : " (missing)"}`,
    `  schema     v${report.schemaVersion}`,
    `  port       ${report.port}`,
    `  server     ${describeServer(report)}`,
    `  paseo      ${describePaseo(report)}`,
    `  providers  ${report.providers.map((provider) => provider.provider).join(", ") || "none"}`,
    `  gates      ${report.pendingGates.length} pending`,
    `  runs       ${report.runs.total} total (${report.runs.active} active)`,
  ].join("\n");
}

function octal(value: number): string {
  return `0${value.toString(8)}`;
}

export async function doctorCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["home", "port"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const version = process.versions.node;
  if (!nodeVersionOk(version)) {
    io.stderr(
      `argos: Node ${version} is too old; Argos needs ${REQUIRED_NODE_VERSION} (built-in SQLite)\n`,
    );
    return EXIT_RUNTIME;
  }

  const homeFlag = flag(args, "home");
  const home = resolve(homeFlag ?? argosHome());
  const port = configuredPort(flag(args, "port"));
  const storagePath = dbPath(home);
  const storageExists = existsSync(storagePath);

  let info: ServerInfo | undefined;
  let serverError: string | undefined;
  const client = new RpcClient({ home, url: `http://127.0.0.1:${port}` });
  try {
    info = await client.info();
  } catch (error) {
    serverError =
      error instanceof RpcClientError
        ? error.unreachable
          ? "argos serve is not running"
          : `${error.code}: ${error.message}`
        : String(error);
  }

  const checks: DoctorCheck[] = [
    { name: "node", ok: true, detail: `v${version} (requires ${REQUIRED_NODE_VERSION})` },
    {
      name: "storage",
      ok: true,
      detail: storageExists ? storagePath : `${storagePath} (not created yet)`,
    },
    {
      name: "server",
      ok: info !== undefined,
      detail: info === undefined ? (serverError ?? "not reachable") : `pid ${info.pid}`,
    },
    {
      name: "paseo",
      ok: info?.paseo.reachable === true,
      detail: info?.paseo.reachable === true ? "reachable" : (info?.paseo.error ?? "not reachable"),
    },
    {
      name: "gates",
      ok: (info?.pendingGates.length ?? 0) === 0,
      detail: `${info?.pendingGates.length ?? 0} pending`,
    },
  ];

  const report: DoctorReport = {
    node: { version, required: REQUIRED_NODE_VERSION, ok: true },
    home,
    storage: {
      path: storagePath,
      exists: storageExists,
      ...(mode(home) === undefined ? {} : { homeMode: mode(home) as number }),
      ...(mode(storagePath) === undefined ? {} : { dbMode: mode(storagePath) as number }),
    },
    schemaVersion: info?.schemaVersion ?? ARGOS_SCHEMA_VERSION,
    port: info?.port ?? port,
    server: {
      reachable: info !== undefined,
      url: `http://127.0.0.1:${info?.port ?? port}`,
      ...(info === undefined ? {} : { pid: info.pid, uptimeMs: info.uptimeMs }),
    },
    paseo: info?.paseo ?? { reachable: false, error: serverError ?? "argos serve is not running" },
    providers: info?.providers ?? [],
    pendingGates: info?.pendingGates ?? [],
    runs: info?.runs ?? { total: 0, active: 0 },
    checks,
  };

  if (args.json) printJson(io, report);
  else io.stdout(`${humanReport(report)}\n`);
  return EXIT_OK;
}
