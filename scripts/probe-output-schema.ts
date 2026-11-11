#!/usr/bin/env node
/**
 * Manual provider capability probe (D12/FR17) — **never runs in CI or in the test suite.**
 *
 * It creates one tiny agent per provider against a *real* daemon, passes the same `outputSchema`
 * Argos compiles for a step, and reports whether the provider returned structured output or only
 * prose. Use the result to refresh `PROVIDER_OUTPUT_CAPABILITIES` in
 * `packages/core/src/paseo/output.ts`.
 *
 * Usage (from the repository root):
 *
 *   npm run build
 *   ARGOS_PASEO_URL=ws://127.0.0.1:6767/ws \
 *   ARGOS_PASEO_PASSWORD='…' \
 *   node --experimental-strip-types scripts/probe-output-schema.ts [provider ...]
 *
 * Defaults to `claude codex opencode pi`; pass provider ids to narrow the probe. The password is
 * read from the environment only and is never printed. Agents are archived at the end.
 *
 * Output is a table:
 *
 *   provider   target                       finish    structured  parsed
 *   claude     claude/sonnet                idle      yes         yes
 *   opencode   opencode/big-pickle          idle      no          yes (fenced json)
 *
 * Nothing here is imported by the package or by tests; it is a developer tool.
 */

import {
  buildStepOutputSchema,
  createPaseoPort,
  parseStepResult,
} from "argos-core/paseo";

const DEFAULT_PROVIDERS = ["claude", "codex", "opencode", "pi"] as const;

const providers =
  process.argv.slice(2).filter((arg) => !arg.startsWith("-")).length > 0
    ? process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
    : [...DEFAULT_PROVIDERS];

const compiled = buildStepOutputSchema({
  outputs: {
    answer: { type: "string", required: true, description: "A one-word answer." },
    confidence: { type: "number", description: "0..1 confidence." },
  },
  outcomes: ["success"],
});

const prompt =
  "Reply only with the structured result requested by the output schema. " +
  'Use answer="probe" and confidence=1, and outcome="success".';

const port = createPaseoPort({ connectTimeoutMs: 10_000 });

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const catalog = await port.providersSnapshot();
  const rows: string[] = [];
  rows.push(
    `${pad("provider", 10)} ${pad("target", 30)} ${pad("finish", 9)} ${pad("structured", 11)} parsed`,
  );

  for (const provider of providers) {
    const entry = catalog.providers.find((candidate) => candidate.provider === provider);
    const model = entry?.models.find((candidate) => candidate.selectable !== false);
    if (entry === undefined || model === undefined) {
      rows.push(`${pad(provider, 10)} ${pad("-", 30)} ${pad("skipped", 9)} no model in catalog`);
      continue;
    }
    const target = `${entry.provider}/${model.id}`;
    let agentId: string | undefined;
    try {
      const agent = await port.create({
        requestId: `argos:probe:${entry.provider}:${Date.now()}`,
        config: { provider: target },
        cwd: process.cwd(),
        prompt,
        labels: { "argos/probe": provider },
        outputSchema: compiled.schema,
      });
      agentId = agent.agentId;
      const finish = await port.waitForFinish(agent.agentId, 120_000);
      const info = await port.refresh(agent.agentId);
      const output = finish.output ?? info?.output;
      const raw = {
        ...(output === undefined ? {} : { output }),
        text: finish.lastMessage ?? info?.lastMessage ?? null,
        provider: target,
      };
      const parsed = parseStepResult(compiled, raw);
      const structured = output !== undefined;
      rows.push(
        `${pad(provider, 10)} ${pad(target, 30)} ${pad(finish.status, 9)} ${pad(
          structured ? "yes" : "no",
          11,
        )} ${parsed.ok ? (structured ? "yes" : "yes (text fallback)") : `no: ${parsed.error}`}`,
      );
    } catch (error) {
      rows.push(
        `${pad(provider, 10)} ${pad(target, 30)} ${pad("error", 9)} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (agentId !== undefined) {
        try {
          await port.archive(agentId);
        } catch {
          // The agent may already be gone; the probe result is what matters.
        }
      }
    }
  }

  console.log(rows.join("\n"));
  console.log(
    "\nUpdate PROVIDER_OUTPUT_CAPABILITIES in packages/core/src/paseo/output.ts with what you observed.",
  );
}

try {
  await main();
} finally {
  await port.close();
}
