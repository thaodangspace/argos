/**
 * The production {@link PaseoPort} over `@getpaseo/client` (Phase 6).
 *
 * **This is the only module in the repository allowed to import `@getpaseo/*`.** The adapter,
 * the durable host, and every test speak the port interface instead, which keeps tests network-
 * free and the rest of the codebase free of SDK types.
 *
 * Configuration is environment-only (spec §Security):
 *
 * | Variable                | Default                     |
 * |-------------------------|-----------------------------|
 * | `ARGOS_PASEO_URL`       | `ws://127.0.0.1:6767/ws`    |
 * | `ARGOS_PASEO_PASSWORD`  | (unset)                     |
 *
 * The password is never logged and is redacted from error messages. Connection failures,
 * authentication failures, and lost session errors all map to `PaseoUnreachableError`
 * (`paseo_unreachable` upstream). Classification lives in `port.ts`; this file only supplies the
 * SDK calls.
 *
 * Known SDK limitation: `waitForFinish()` returns `lastMessage` text but no structured JSON
 * value, so `FinishResult.output` stays undefined there and agent steps rely on the documented
 * D12 fenced-JSON fallback. The manual probe (`scripts/probe-output-schema.ts`) records which
 * providers emit JSON in that final message.
 */

import {
  createPaseoClient,
  type PaseoClient,
  type PaseoLogger,
} from "@getpaseo/client";

import {
  AgentMissingError,
  classifyPaseoFailure,
  LabelFilterUnsupportedError,
  PaseoUnreachableError,
  type AgentInfo,
  type AgentRef,
  type CreateAgentInput,
  type FinishResult,
  type PaseoAgentStatus,
  type PaseoPort,
  type ProviderCatalog,
} from "./port.js";

/** D2/FR27: the loopback daemon URL when neither the option nor the env var is set. */
export const DEFAULT_PASEO_URL = "ws://127.0.0.1:6767/ws";

/** Minimal structural view of the SDK's agent snapshot (no SDK types escape this module). */
interface ClientAgentSnapshot {
  readonly id: string;
  readonly provider: string;
  readonly model?: string | null;
  readonly status?: string;
  readonly archivedAt?: string | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly pendingPermissions?: readonly unknown[];
  readonly lastError?: string | null;
  readonly lastUsage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly totalCostUsd?: number;
    readonly contextWindowUsedTokens?: number;
  };
}

interface ClientAgentEntry {
  readonly agent?: ClientAgentSnapshot;
}

interface ClientProviderModel {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly isSelectable?: boolean;
}

interface ClientProviderEntry {
  readonly provider: string;
  readonly enabled?: boolean;
  readonly error?: string;
  readonly models?: readonly ClientProviderModel[];
}

interface ClientProviderSnapshot {
  readonly entries?: readonly ClientProviderEntry[];
  readonly generatedAt?: string;
  readonly fetchedAt?: string;
}

export interface PaseoClientPortOptions {
  /** `ARGOS_PASEO_URL`; default {@link DEFAULT_PASEO_URL}. */
  readonly url?: string;
  /** `ARGOS_PASEO_PASSWORD`; never logged. */
  readonly password?: string;
  readonly logger?: PaseoLogger;
  readonly connectTimeoutMs?: number;
  /**
   * Capability flag for daemons that cannot filter by label. Default `true` (the current daemon
   * supports it); a `false` value makes `listByLabels` throw `LabelFilterUnsupportedError`, which
   * turns a crash-window re-entry into `launch_uncertain` instead of a duplicate create.
   */
  readonly supportsLabelFilter?: boolean;
}

/** `PaseoPort` plus the lifecycle hook `argos serve` uses on shutdown. */
export interface PaseoClientPort extends PaseoPort {
  /** The resolved daemon URL (never includes the password). */
  readonly url: string;
  close(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove the password from any message that might have echoed it. */
function redact(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return message;
  return message.split(secret).join("***");
}

function mapStatus(snapshot: ClientAgentSnapshot): PaseoAgentStatus {
  if ((snapshot.pendingPermissions?.length ?? 0) > 0) return "permission";
  switch (snapshot.status) {
    case "initializing":
      return "initializing";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "error":
      return "error";
    case "closed":
      return "closed";
    default:
      return "running";
  }
}

function targetOfSnapshot(snapshot: ClientAgentSnapshot): string | undefined {
  if (typeof snapshot.model !== "string" || snapshot.model.length === 0) return undefined;
  return `${snapshot.provider}/${snapshot.model}`;
}

function usageOf(snapshot: ClientAgentSnapshot | null): Record<string, number> | undefined {
  const usage = snapshot?.lastUsage;
  if (usage === undefined) return undefined;
  const record: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) record[key] = value;
  }
  return Object.keys(record).length === 0 ? undefined : record;
}

function toAgentRef(snapshot: ClientAgentSnapshot): AgentRef {
  const target = targetOfSnapshot(snapshot);
  return {
    agentId: snapshot.id,
    ...(target === undefined ? {} : { target }),
    status: mapStatus(snapshot),
    archived: snapshot.archivedAt !== null && snapshot.archivedAt !== undefined,
    ...(snapshot.labels === undefined ? {} : { labels: snapshot.labels }),
  };
}

function toAgentInfo(snapshot: ClientAgentSnapshot): AgentInfo {
  const target = targetOfSnapshot(snapshot);
  const usage = usageOf(snapshot);
  return {
    agentId: snapshot.id,
    status: mapStatus(snapshot),
    ...(target === undefined ? {} : { target }),
    archived: snapshot.archivedAt !== null && snapshot.archivedAt !== undefined,
    lastMessage: null,
    error: snapshot.lastError ?? null,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Build the production port. The client connects lazily on the first call and is reused; a lost
 * connection is dropped so the next call reconnects. Nothing here opens a socket at construction
 * time, so `ArgosHost.open` never depends on a live daemon.
 */
export function createPaseoPort(options: PaseoClientPortOptions = {}): PaseoClientPort {
  const url = options.url ?? process.env["ARGOS_PASEO_URL"] ?? DEFAULT_PASEO_URL;
  const password = options.password ?? process.env["ARGOS_PASEO_PASSWORD"];
  let client: PaseoClient | undefined;
  let connecting: Promise<PaseoClient> | undefined;

  async function connect(): Promise<PaseoClient> {
    if (client !== undefined) return client;
    if (connecting === undefined) {
      connecting = (async () => {
        const created = createPaseoClient({
          url,
          ...(password === undefined ? {} : { password }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          ...(options.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: options.connectTimeoutMs }),
          // Argos owns retry pacing (the durable step parks and retries); an internal reconnect
          // loop would turn a hard failure into a silent hang instead of `paseo_unreachable`.
          reconnect: { enabled: false },
        });
        try {
          await created.connect();
        } catch (cause) {
          try {
            await created.close();
          } catch {
            // The connect already failed; a failing close adds no information.
          }
          throw new PaseoUnreachableError(
            redact(`cannot connect to Paseo at ${url}: ${errorMessage(cause)}`, password),
            { cause, url },
          );
        }
        client = created;
        return created;
      })().finally(() => {
        connecting = undefined;
      });
    }
    return connecting;
  }

  /** Run one SDK call, classifying its failure and dropping a dead connection. */
  async function call<T>(operation: (api: PaseoClient) => Promise<T>): Promise<T> {
    const api = await connect();
    try {
      return await operation(api);
    } catch (cause) {
      const classified = classifyPaseoFailure(cause, { url });
      if (classified instanceof PaseoUnreachableError) {
        // Force a fresh connect on the next call; the harness keeps the run alive.
        client = undefined;
        const message = redact(classified.message, password);
        throw new PaseoUnreachableError(message, { cause: classified, url });
      }
      throw classified instanceof Error ? classified : new Error(String(classified));
    }
  }

  return {
    url,
    supportsLabelFilter: options.supportsLabelFilter ?? true,

    async listByLabels(labels: Readonly<Record<string, string>>): Promise<AgentRef[]> {
      if (options.supportsLabelFilter === false) {
        throw new LabelFilterUnsupportedError();
      }
      const result = await call((api) =>
        api.agents.list({ filter: { labels: { ...labels }, includeArchived: true } }),
      );
      const entries = (result.entries ?? []) as readonly (ClientAgentEntry | ClientAgentSnapshot)[];
      return entries.map((entry) => {
        const snapshot = "agent" in entry && entry.agent !== undefined
          ? entry.agent
          : (entry as ClientAgentSnapshot);
        return toAgentRef(snapshot);
      });
    },

    async create(input: CreateAgentInput): Promise<AgentRef> {
      const handle = await call((api) =>
        api.agents.create({
          config: {
            provider: input.config.provider,
            ...(input.config.modeId === undefined ? {} : { modeId: input.config.modeId }),
            ...(input.config.thinkingOptionId === undefined
              ? {}
              : { thinkingOptionId: input.config.thinkingOptionId }),
          },
          cwd: input.cwd,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          labels: { ...input.labels },
          ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
          // Stable across restarts: the daemon deduplicates a retried create itself.
          idempotencyKey: input.requestId,
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      );
      return {
        agentId: handle.id,
        target: input.config.provider,
        status: "running",
        archived: false,
      };
    },

    async refresh(agentId: string): Promise<AgentInfo | null> {
      const refetched = await call((api) => api.agents.ref(agentId).refresh());
      if (refetched === null) return null;
      const snapshot = (refetched as { agent?: ClientAgentSnapshot }).agent;
      if (snapshot === undefined) throw new AgentMissingError(agentId);
      return toAgentInfo(snapshot);
    },

    async waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
      const result = await call((api) => api.agents.ref(agentId).waitForFinish(timeoutMs));
      const final = (result.final ?? null) as ClientAgentSnapshot | null;
      const usage = usageOf(final);
      return {
        status: result.status,
        final: final === null ? null : toAgentInfo(final),
        error: result.error ?? null,
        lastMessage: result.lastMessage ?? null,
        ...(usage === undefined ? {} : { usage }),
      };
    },

    async archive(agentId: string): Promise<void> {
      await call((api) => api.agents.ref(agentId).archive().then(() => undefined));
    },

    async providersSnapshot(): Promise<ProviderCatalog> {
      const result = await call((api) => api.providers.snapshot());
      // `snapshot()` returns the payload directly; accept a wrapped payload defensively.
      const payload = ((result as { payload?: unknown }).payload ?? result) as ClientProviderSnapshot;
      const entries = payload.entries ?? [];
      const fetchedAt =
        payload.generatedAt === undefined ? undefined : Date.parse(payload.generatedAt);
      return {
        providers: entries.map((entry) => {
          const models = (entry.models ?? []).map((model) => ({
            provider: entry.provider,
            id: model.id,
            ...(model.aliases === undefined ? {} : { aliases: model.aliases }),
            selectable: model.isSelectable !== false,
          }));
          return {
            provider: entry.provider,
            enabled: entry.enabled !== false,
            models,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          };
        }),
        ...(fetchedAt === undefined || Number.isNaN(fetchedAt) ? {} : { fetchedAt }),
      };
    },

    async close(): Promise<void> {
      const current = client;
      client = undefined;
      if (current === undefined) return;
      try {
        await current.close();
      } catch (cause) {
        throw new PaseoUnreachableError(
          redact(`closing the Paseo client failed: ${errorMessage(cause)}`, password),
          { cause, url },
        );
      }
    },
  };
}
