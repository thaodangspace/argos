import { describe, expect, it } from "vitest";

import { playbook, step } from "../../src/engine/test-util.js";
import {
  DEFAULT_EXHAUSTED_WINDOW_MS,
  ModelCatalog,
  isTargetExhausted,
  resolveStepTargets,
} from "../../src/paseo/model-catalog.js";
import { DEFAULT_FAKE_CATALOG, FakePaseoPort } from "../fakes/paseo.js";

const ir = playbook({
  id: "targets",
  steps: [
    step({
      id: "build",
      agent: { provider: "claude", model: "opus", labels: {} },
      fallbacks: [
        { provider: "codex", model: "gpt" },
        { provider: "pi", model: "large" },
      ],
    }),
    step({
      id: "verify",
      needs: ["build"],
      agent: { provider: "claude", model: "sonnet", labels: {} },
    }),
  ],
  after: [
    {
      id: "report",
      title: "Report",
      trigger: "auto",
      steps: [step({ id: "report-step", agent: { provider: "ghost", model: "missing", labels: {} } })],
    },
  ],
});

describe("model catalog (FR24)", () => {
  it("loads providers.snapshot() and exposes a stable doctor shape", async () => {
    const port = new FakePaseoPort();
    const catalog = await ModelCatalog.load(port, { now: () => 1_000 });
    const snapshot = catalog.snapshot();

    expect(snapshot.generatedAt).toBe(1_000);
    expect(snapshot.targets).toEqual(["claude/opus", "claude/sonnet", "codex/gpt"]);
    expect(snapshot.providers).toEqual([
      {
        provider: "claude",
        enabled: true,
        models: ["claude/opus", "claude/sonnet"],
      },
      { provider: "codex", enabled: true, models: ["codex/gpt"] },
    ]);
    expect(catalog.has("claude/opus")).toBe(true);
    expect(catalog.has("claude/haiku")).toBe(false);
  });

  it("names every unknown resolved target, including fallbacks and after-task steps", () => {
    const catalog = ModelCatalog.fromSnapshot(DEFAULT_FAKE_CATALOG);
    expect(catalog.missingTargets(ir)).toEqual(["ghost/missing", "pi/large"]);
  });

  it("accepts model aliases but lists only canonical targets", () => {
    const catalog = ModelCatalog.fromSnapshot({
      providers: [
        {
          provider: "claude",
          enabled: true,
          models: [{ provider: "claude", id: "opus", aliases: ["claude-opus"] }],
        },
      ],
    });
    expect(catalog.has("claude/claude-opus")).toBe(true);
    expect(catalog.targets).toEqual(["claude/opus"]);
  });

  it("resolves step > role/playbook defaults, then role fallbacks, in order", () => {
    const [build] = ir.steps;
    expect(build).toBeDefined();
    expect(resolveStepTargets(build!)).toEqual(["claude/opus", "codex/gpt", "pi/large"]);
  });

  it("skips exhausted targets inside the configurable window", () => {
    const catalog = ModelCatalog.fromSnapshot(DEFAULT_FAKE_CATALOG, { exhaustedWindowMs: 60_000 });
    const [build] = ir.steps;
    const now = 100_000;
    expect(isTargetExhausted("claude/opus", [{ target: "claude/opus", at: 50_000 }], now)).toBe(true);
    expect(
      catalog.availableTargets(
        build!,
        [
          { target: "claude/opus", at: now - 30_000 },
          { target: "codex/gpt", at: now - DEFAULT_EXHAUSTED_WINDOW_MS },
        ],
        now,
      ),
    ).toEqual(["codex/gpt", "pi/large"]);
  });

  it("renders whole-value input templates in a target before validating", () => {
    const templated = playbook({
      id: "templated",
      steps: [
        step({
          id: "a",
          agent: { provider: "{{ inputs.provider }}", model: "{{ inputs.model }}", labels: {} },
        }),
      ],
    });
    const catalog = ModelCatalog.fromSnapshot(DEFAULT_FAKE_CATALOG);
    expect(
      catalog.missingTargets(templated, { provider: "claude", model: "opus" }),
    ).toEqual([]);
    expect(
      catalog.missingTargets(templated, { provider: "claude", model: "haiku" }),
    ).toEqual(["claude/haiku"]);
  });
});
