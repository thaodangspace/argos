/**
 * The `hc` target catalog (FR18, plan Phase 6 verification 9).
 *
 * A playbook targets herdr-core the way it targets Paseo — `agent: { provider: hc, model:
 * <template> }` — so the canonical target is `hc/<template>`, the catalog is `templates.list`, and a
 * missing template is the existing `model_unavailable` refusal **before any task exists**. The suite
 * pins the three claims that keep that true: only hc-provider steps are checked, `{{ inputs.x }}` is
 * rendered like `ModelCatalog` renders it, and a missing template never reaches a terminal.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { isArgosError } from "../../src/errors.js";
import { createHcStepExecutor } from "../../src/hc/agent-step.js";
import { HC_PROVIDER, HcCatalog, hcTargetOf } from "../../src/hc/catalog.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { FakeHcPort } from "../fakes/hc.js";

describe("hc catalog (FR18)", () => {
  it("builds canonical hc/<template> targets from templates.list", async () => {
    const port = new FakeHcPort({ templates: ["claude", "codex"] });
    const catalog = await HcCatalog.load(port);

    expect(port.templateCalls).toBe(1);
    expect(HC_PROVIDER).toBe("hc");
    expect(catalog.targets).toEqual(["hc/claude", "hc/codex"]);
    expect(catalog.has("hc/claude")).toBe(true);
    // The alias family of FR1 applies to a target's provider too.
    expect(catalog.has("herdr/claude")).toBe(true);
    expect(catalog.has("herdr-core/codex")).toBe(true);
    // Another substrate's target is not this catalog's business.
    expect(catalog.has("claude/opus")).toBe(false);
    expect(catalog.has("hc/missing")).toBe(false);
    expect(catalog.has("claude")).toBe(false);
  });

  it("never offers a template the core marks unusable", () => {
    const catalog = HcCatalog.fromTemplates([
      { name: "claude", description: "", command: "claude", error: null },
      { name: "broken", description: "", command: "broken", error: "no such binary" },
      { name: "  ", description: "", command: "", error: null },
    ]);
    expect(catalog.targets).toEqual(["hc/claude"]);
    expect(catalog.has("hc/broken")).toBe(false);
  });

  it("normalizes a target's provider and rejects everything that is not hc", () => {
    expect(hcTargetOf("hc/claude")).toBe("hc/claude");
    expect(hcTargetOf(" Herdr-Core / claude ")).toBe("hc/claude");
    expect(hcTargetOf("hc/")).toBeUndefined();
    expect(hcTargetOf("hc")).toBeUndefined();
    expect(hcTargetOf("codex/gpt")).toBeUndefined();
  });

  it("reports only hc targets, main graph and after-tasks, with inputs rendered", () => {
    const catalog = HcCatalog.fromTemplates([
      { name: "claude", description: "", command: "claude", error: null },
      { name: "codex", description: "", command: "codex", error: null },
    ]);
    const ir = playbook({
      id: "hc-targets",
      steps: [
        step({ id: "build", agent: { provider: "hc", model: "claude", labels: {} } }),
        step({
          id: "report",
          needs: ["build"],
          agent: { provider: "herdr-core", model: "{{ inputs.template }}", labels: {} },
        }),
        // A Paseo step is ignored: one run uses one substrate, and this catalog is `hc`'s.
        step({ id: "paseo-step", needs: ["build"], agent: { provider: "claude", model: "opus", labels: {} } }),
      ],
      after: [
        {
          id: "cleanup",
          title: "Cleanup",
          trigger: "auto",
          steps: [step({ id: "cleanup-step", agent: { provider: "hc", model: "missing", labels: {} } })],
        },
      ],
    });

    expect(catalog.missingTargets(ir, { template: "codex" })).toEqual(["hc/missing"]);
    // Without the input the template stays literal, exactly like `ModelCatalog` (no guessing).
    expect(catalog.missingTargets(ir)).toEqual(["hc/missing", "hc/{{ inputs.template }}"]);
    expect(catalog.missingTargets(ir, { template: "gone" })).toEqual(["hc/gone", "hc/missing"]);
  });
});

describe("hc catalog through the durable host (FR18)", () => {
  it("refuses a playbook naming hc/missing with model_unavailable before any task", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const catalog = await HcCatalog.load(port);
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: new FakeExecutor(),
      executors: { hc: createHcStepExecutor({ port, catalog, home: "/tmp/argos-home" }) },
      catalogs: { hc: catalog },
    });
    try {
      const ir = playbook({
        id: "hc-missing",
        steps: [
          step({
            id: "build",
            agent: { provider: "hc", model: "missing", labels: {} },
            prompt: "Build the change.",
          }),
        ],
      });
      const error: unknown = await host
        .startRun({ ir, inputs: {}, cwd: "/tmp/argos-hc-missing", executor: "hc", id: "run-hc-missing" })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(isArgosError(error)).toBe(true);
      if (isArgosError(error)) {
        expect(error.code).toBe("model_unavailable");
        // The message names the canonical target, never a template the core actually has.
        expect(error.message).toContain("hc/missing");
      }
      expect(await host.listRuns()).toEqual([]);
      expect((await host.inspect()).tasks).toEqual([]);
      expect(port.runs).toHaveLength(0);
      expect(port.runCalls).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
