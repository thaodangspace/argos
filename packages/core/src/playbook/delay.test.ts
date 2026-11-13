import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook } from "./load.js";

const roots: string[] = [];

/** Write one playbook into a scratch repository and load it. */
function load(body: string) {
  const root = mkdtempSync(join(tmpdir(), "argos-delay-"));
  roots.push(root);
  const file = join(root, ".argos/playbooks/p.yaml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return loadPlaybook(root, "p");
}

function loadError(body: string): { code?: string; message: string } {
  try {
    load(body);
  } catch (error) {
    if (isArgosError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected playbook_invalid");
}

const LOOP = (wait: string): string =>
  [
    "title: Loop",
    "defaults:",
    "  agent: { provider: claude, model: opus }",
    "steps:",
    "  - id: tick",
    "    prompt: Do one tick",
    "  - id: wait",
    "    needs: [tick]",
    ...wait.split("\n").map((line) => `    ${line}`),
    "    on:",
    "      success: { goto: tick, max_loops: 96 }",
    "",
  ].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadPlaybook: delay steps", () => {
  it("infers kind delay from `delay:` and keeps the duration as written", () => {
    const ir = load(LOOP("delay: 30m"));
    const wait = ir.steps.find((step) => step.id === "wait");
    expect(wait?.kind).toBe("delay");
    expect(wait?.delay).toBe("30m");
    expect(wait?.outcomes).toEqual(["success", "failure"]);
    expect(wait?.script).toBeUndefined();
  });

  it("accepts an explicit kind, a number of ms, and a declared input template", () => {
    expect(load(LOOP("kind: delay\ndelay: 90000")).steps[1]?.delay).toBe(90_000);
    const templated = load(
      LOOP('delay: "{{ inputs.interval }}"').replace(
        "steps:",
        "inputs:\n  interval: { type: string, default: 30m }\nsteps:",
      ),
    );
    expect(templated.steps[1]?.delay).toBe("{{ inputs.interval }}");
  });

  it("adds no `delay` key to steps that are not delays (existing IR hashes stay put)", () => {
    const body = LOOP("script: wait.sh").replace("script: wait.sh", "prompt: Wait");
    expect(load(body).steps[1]?.delay).toBeUndefined();
    expect(JSON.stringify(load(body))).not.toContain('"delay"');
  });

  it.each([
    ["timeout: 35m", "`timeout`"],
    ["retries: 1", "`retries`"],
    ["script: wait.sh", "`script`"],
    ["prompt: Wait", "`prompt`"],
    ["outputs: { slept: { type: number } }", "`outputs`"],
  ])("refuses `%s` on a delay step", (extra, field) => {
    const error = loadError(LOOP(`delay: 30m\n${extra}`));
    expect(error.code).toBe("playbook_invalid");
    expect(error.message).toContain(field);
  });

  it.each([
    ["delay: soon", "positive duration"],
    ["delay: 0", "positive duration"],
    ["delay: 0s", "positive duration"],
    ['delay: "{{ inputs.missing }}"', 'undeclared input "missing"'],
  ])("refuses `%s`", (line, detail) => {
    const error = loadError(LOOP(line));
    expect(error.code).toBe("playbook_invalid");
    expect(error.message).toContain(detail);
  });

  it("refuses kind: delay without a `delay`", () => {
    const error = loadError(LOOP("kind: delay\nprompt: Wait"));
    expect(error.code).toBe("playbook_invalid");
  });
});
