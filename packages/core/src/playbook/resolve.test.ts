import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadPlaybook } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const PRECEDENCE = join(FIXTURES, "precedence");

describe("resolveAgentCore: precedence step > role > playbook > defaults (FR24)", () => {
  it.each([
    { id: "step-wins", provider: "step-provider", model: "step-model" },
    { id: "role-wins", provider: "role-provider", model: "role-model" },
    { id: "playbook-wins", provider: "playbook-provider", model: "playbook-model" },
    { id: "defaults-wins", provider: "defaults-provider", model: "defaults-model" },
  ])("$id resolves $provider/$model", ({ id, provider, model }) => {
    const ir = loadPlaybook(PRECEDENCE, id);
    expect(ir.steps[0]?.agent).toMatchObject({ provider, model });
  });

  it("resolves the same precedence for the role record and the playbook defaults", () => {
    const roleWins = loadPlaybook(PRECEDENCE, "role-wins");
    expect(roleWins.roles["worker"]?.agent).toMatchObject({
      provider: "role-provider",
      model: "role-model",
    });
    // The playbook's `agent:` + repo defaults resolve the playbook-level default.
    expect(roleWins.defaults?.agent).toMatchObject({
      provider: "playbook-provider",
      model: "playbook-model",
    });
  });
});

describe("when and branch parsing (FR21)", () => {
  const ir = loadPlaybook(join(FIXTURES, "when"), "conditional");
  const route = ir.steps.find((step) => step.id === "route");
  const ship = ir.steps.find((step) => step.id === "ship");

  it("parses a branch step into ordered cases with its implicit outcomes", () => {
    expect(route?.kind).toBe("branch");
    expect(route?.branch?.cases).toStrictEqual([
      { name: "service", when: { "steps.classify.outputs.kind": "service" } },
      { name: "other" },
    ]);
    expect(route?.outcomes).toStrictEqual(["service", "other"]);
  });

  it("parses a when condition", () => {
    expect(ship?.when).toStrictEqual({ "steps.route.outcome": "service" });
  });

  it("survives a JSON round-trip unchanged", () => {
    const roundTrip = JSON.parse(JSON.stringify(ir));
    expect(roundTrip).toStrictEqual(ir);
    expect(roundTrip.steps[1].branch).toStrictEqual(route?.branch);
    expect(roundTrip.steps[2].when).toStrictEqual({ "steps.route.outcome": "service" });
  });

  it("produces the same hash across two loads", () => {
    expect(loadPlaybook(join(FIXTURES, "when"), "conditional").hash).toBe(ir.hash);
  });
});
