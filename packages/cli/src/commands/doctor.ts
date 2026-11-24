/**
 * `argos doctor` (FR25, NFR Observability) — works with and without a running server.
 *
 * Without a server it reports what it can read safely: the storage path and modes, the configured
 * port, the Node runtime check, and "not reachable" for the daemon. With a server it adds the live
 * `GET /info` view (schema version, actual port, pid, Paseo reachability, provider catalog, pending
 * gates, run counters) and the `hc templates` check (FR17). It **never** opens SQLite: the database
 * is a `stat` at most, and an hc pack manifest is one small JSON file.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { argosHome, dbPath } from "@thaodangspace/argos-core";
import {
  ARGOS_SCHEMA_VERSION,
  DEFAULT_ARGOS_PORT,
  RpcClient,
  RpcClientError,
  type DoctorCheck,
  type DoctorReport,
  type ExecutorInfo,
  type ScheduleSummary,
  type ServerInfo,
} from "@thaodangspace/argos-core/rpc";

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import {
  emptyManifest,
  parseManifest,
  parsePack,
  type PackManifest,
} from "../packs/pack.js";
import { bundledPacks } from "../packs/bundled.js";
import { manifestPath } from "../packs/templates-dir.js";
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

/**
 * FR9: every registered executor with its reachability, its version when it reports one, and the
 * adapter's error when it is down. `paseo (default, reachable), hc (not reachable: …)`.
 */
function describeExecutors(executors: readonly ExecutorInfo[]): string {
  if (executors.length === 0) return "none";
  return executors
    .map((executor) => {
      const flags = [
        ...(executor.default ? ["default"] : []),
        executor.reachable
          ? "reachable"
          : `not reachable${executor.error === undefined ? "" : `: ${executor.error}`}`,
        ...(executor.version === undefined ? [] : [`v${executor.version}`]),
      ];
      return `${executor.id} (${flags.join(", ")})`;
    })
    .join(", ");
}

function humanReport(report: DoctorReport): string {
  const homeMode = report.storage.homeMode === undefined ? "" : ` (${octal(report.storage.homeMode)})`;
  const dbMode =
    report.storage.dbMode === undefined ? " (not created yet)" : ` (${octal(report.storage.dbMode)})`;
  const lines = [
    `argos doctor`,
    `  node       v${report.node.version} (requires ${report.node.required})`,
    `  home       ${report.home}${homeMode}`,
    `  storage    ${report.storage.path}${report.storage.exists ? dbMode : " (missing)"}`,
    `  schema     v${report.schemaVersion}`,
    `  port       ${report.port}`,
    `  server     ${describeServer(report)}`,
    `  paseo      ${describePaseo(report)}`,
    `  providers  ${report.providers.map((provider) => provider.provider).join(", ") || "none"}`,
  ];
  // FR9: the executor line only exists when the server answered (it owns the registry).
  if (report.executors !== undefined) {
    lines.push(`  executors  ${describeExecutors(report.executors)}`);
  }
  lines.push(
    `  gates      ${report.pendingGates.length} pending`,
    `  runs       ${report.runs.total} total (${report.runs.active} active)`,
  );
  // FR10.3: the schedules line only exists when the server answered. FR17: so does `templates`.
  const schedules = report.checks.find((check) => check.name === "schedules");
  if (schedules !== undefined) lines.push(`  schedules  ${schedules.detail}`);
  const templates = report.checks.find((check) => check.name === "hc templates");
  if (templates !== undefined) lines.push(`  templates  ${templates.detail}`);
  return lines.join("\n");
}

function octal(value: number): string {
  return `0${value.toString(8)}`;
}

/**
 * FR10.3: the scheduler's health, as `checks[]` sees it. The report schema does not change — this
 * is one more entry. A refused last fire of an enabled schedule is the one thing that turns the
 * entry red, and the detail always carries the counts plus the earliest upcoming fire.
 */
function schedulesCheck(
  schedules: readonly ScheduleSummary[] | undefined,
  error: string | undefined,
): DoctorCheck {
  if (schedules === undefined) {
    return { name: "schedules", ok: false, detail: error ?? "cannot list schedules" };
  }
  const enabled = schedules.filter((schedule) => schedule.enabled);
  const paused = schedules.length - enabled.length;
  const refused = enabled.filter((schedule) => schedule.lastFire?.status === "refused").length;
  const upcoming = enabled.flatMap((schedule) =>
    schedule.nextFireAt === null ? [] : [schedule.nextFireAt],
  );
  const earliest = upcoming.length === 0 ? undefined : Math.min(...upcoming);
  return {
    name: "schedules",
    ok: refused === 0,
    detail:
      `${enabled.length} enabled, ${paused} paused, ${refused} refused;` +
      ` next ${earliest === undefined ? "-" : new Date(earliest).toISOString()}`,
  };
}

/**
 * FR17: the pack manifest (`$ARGOS_HOME/hc/packs.json`), or why it cannot be read. Absent is fine —
 * nothing installed is a state, not a failure — so only a present-but-unreadable/hand-edited file
 * is an error.
 */
function readPackManifest(home: string): { manifest?: PackManifest; error?: string } {
  const file = manifestPath(home);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return existsSync(file) ? { error: `${file} is not readable` } : {};
  }
  const parsed = parseManifest(text, file);
  if (parsed.ok) return { manifest: parsed.value };
  const first = parsed.issues[0];
  return { error: first === undefined ? `${file} is invalid` : `${first.path}: ${first.message}` };
}

/** FR17: the binary's own pack versions, the other side of "a manifest pack is behind". */
function bundledVersions(): Readonly<Record<string, number>> {
  const versions: Record<string, number> = {};
  let bundled: ReturnType<typeof bundledPacks>;
  try {
    bundled = bundledPacks();
  } catch {
    // A tarball built without its `templates/`: nothing to compare against (the install refuses).
    return versions;
  }
  for (const name of bundled.names) {
    const file = join(bundled.dir, name, "pack.json");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parsePack(text, file);
    if (parsed.ok) versions[parsed.value.name] = parsed.value.version;
  }
  return versions;
}

function templateCount(count: number): string {
  return `${count} template${count === 1 ? "" : "s"}`;
}

/**
 * FR17: one `checks[]` entry — is what the manifest claims installed in the **live** hc roster, and
 * is any installed pack behind the binary's own version?
 *
 * Exported (and pure) so the detail strings can be pinned without synthesising a bundle; the
 * command always calls it with {@link bundledVersions}. Absent-safe: the caller only adds the entry
 * when a server answered, and an empty manifest is `ok` with a "not installed" detail.
 */
export function hcTemplatesCheck(input: {
  readonly manifest: PackManifest | undefined;
  readonly manifestError?: string;
  readonly executors: readonly ExecutorInfo[];
  readonly bundled: Readonly<Record<string, number>>;
}): DoctorCheck {
  const name = "hc templates";
  if (input.manifestError !== undefined) {
    return {
      name,
      ok: false,
      detail: `${input.manifestError}; run \`argos hc templates install\``,
    };
  }
  const manifest = input.manifest ?? emptyManifest();
  const packs = Object.keys(manifest.packs).sort();
  if (packs.length === 0) {
    return { name, ok: true, detail: "not installed; run `argos hc templates install`" };
  }
  const installed = packs.flatMap((pack) => Object.keys(manifest.packs[pack]?.templates ?? {}));
  const hc = input.executors.find((executor) => executor.id === "hc");
  const roster = hc?.templates;
  const problems: string[] = [];

  if (roster === undefined) {
    problems.push(
      hc === undefined
        ? "the running server does not register the hc executor (restart `argos serve` with a reachable herdr-core)"
        : "the running server does not publish its hc templates, so this cannot be checked (restart `argos serve`)",
    );
  } else {
    const missing = installed.filter(
      (template) => !roster.includes(`hc/${template}`) && !roster.includes(template),
    );
    if (missing.length > 0) {
      problems.push(
        `not in the running server's catalog: ${missing.sort().join(", ")} (restart \`argos serve\`)`,
      );
    }
  }
  for (const pack of packs) {
    const entry = manifest.packs[pack];
    const bundled = input.bundled[pack];
    if (entry === undefined || bundled === undefined || bundled <= entry.version) continue;
    problems.push(
      `${pack} ${entry.version} installed, ${bundled} bundled; run \`argos hc templates install\``,
    );
  }

  if (problems.length > 0) {
    return { name, ok: false, detail: `${templateCount(installed.length)}; ${problems.join("; ")}` };
  }
  return {
    name,
    ok: true,
    detail: `${templateCount(installed.length)} in the running server's catalog`,
  };
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

  // FR10.3: only meaningful while the server answers; a failed call (an older server, a blip)
  // is reported in the check and never breaks the rest of the report.
  let schedules: readonly ScheduleSummary[] | undefined;
  let schedulesError: string | undefined;
  if (info !== undefined) {
    try {
      schedules = (await client.listSchedules()).schedules;
    } catch (error) {
      schedulesError =
        error instanceof RpcClientError ? `${error.code}: ${error.message}` : String(error);
    }
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
  if (info !== undefined) checks.push(schedulesCheck(schedules, schedulesError));
  // FR17: the hc pack check needs the live registry, so it only exists when a server answered.
  if (info !== undefined) {
    const packs = readPackManifest(home);
    checks.push(
      hcTemplatesCheck({
        manifest: packs.manifest,
        ...(packs.error === undefined ? {} : { manifestError: packs.error }),
        executors: info.executors ?? [],
        bundled: bundledVersions(),
      }),
    );
  }

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
    // FR9: absent (not `[]`) without a server, so an unreachable-server report does not claim the
    // registry is empty; the key's presence means "a server answered".
    ...(info?.executors === undefined ? {} : { executors: info.executors }),
    pendingGates: info?.pendingGates ?? [],
    runs: info?.runs ?? { total: 0, active: 0 },
    checks,
  };

  if (args.json) printJson(io, report);
  else io.stdout(`${humanReport(report)}\n`);
  return EXIT_OK;
}
