/**
 * FR2.2–FR2.5: `env:` grants at load time.
 *
 * A malformed grant is a load error naming the step; `"*"` and a deny-listed name only warn, and
 * a warning never changes the IR or its hash (FR7.4). The entries stay in the IR exactly as the
 * playbook wrote them — `engine/env.ts` is what enforces them at spawn time.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook, type LoadWarning } from "./load.js";

interface TempTree {
  readonly root: string;
  write(relativePath: string, body: string): string;
  cleanup(): void;
}

function tempTree(): TempTree {
  const root = mkdtempSync(join(tmpdir(), "argos-env-"));
  return {
    root,
    write(relativePath: string, body: string): string {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A playbook with one script step whose `env:` list is `entry` (YAML flow or block form). */
function scriptPlaybook(env: readonly string[]): string {
  return [
    "title: Env grants",
    "steps:",
    "  - id: build",
    "    script: build.mjs",
    `    env: [${env.map((entry) => JSON.stringify(entry)).join(", ")}]`,
    "",
  ].join("\n");
}

/** Load `body` as `.argos/playbooks/<id>.yaml` and hand back the warnings it produced. */
function load(tree: TempTree, id: string, body: string): { warnings: LoadWarning[] } {
  tree.write(`.argos/playbooks/${id}.yaml`, body);
  const warnings: LoadWarning[] = [];
  loadPlaybook(tree.root, id, { warnings });
  return { warnings };
}

describe("a malformed env grant is playbook_invalid (FR2.3)", () => {
  it.each([
    { entry: "FOO*", why: "a prefix must end in an underscore" },
    { entry: "*_X", why: "a wildcard is only a trailing prefix" },
    { entry: "A B", why: "a name cannot contain a space" },
    { entry: "", why: "an empty entry grants nothing" },
  ])("rejects $entry ($why) and names the step", ({ entry }) => {
    const tree = tempTree();
    try {
      tree.write(`.argos/playbooks/bad.yaml`, scriptPlaybook([entry]));
      const refused = (() => {
        try {
          loadPlaybook(tree.root, "bad");
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(isArgosError(refused)).toBe(true);
      if (!isArgosError(refused)) return;
      expect(refused.code).toBe("playbook_invalid");
      expect(refused.stepId).toBe("build");
      expect(refused.file).toBe(join(tree.root, ".argos", "playbooks", "bad.yaml"));
    } finally {
      tree.cleanup();
    }
  });

  it("accepts the three grant forms", () => {
    const tree = tempTree();
    try {
      tree.write(
        ".argos/playbooks/good.yaml",
        scriptPlaybook(["MY_API_KEY", "NPM_*", "*", "LC_ALL"]),
      );
      const ir = loadPlaybook(tree.root, "good");
      expect(ir.steps[0]?.script?.env).toStrictEqual(["MY_API_KEY", "NPM_*", "*", "LC_ALL"]);
    } finally {
      tree.cleanup();
    }
  });

  it("rejects a malformed script env inside an after-task step, naming that step", () => {
    const tree = tempTree();
    try {
      tree.write(
        ".argos/playbooks/after-bad.yaml",
        [
          "title: After env",
          "steps:",
          "  - id: main",
          "    prompt: Main",
          "after:",
          "  - id: report",
          "    trigger: auto",
          "    steps:",
          "      - id: publish",
          "        script: build.mjs",
          "        env: [FOO*]",
          "",
        ].join("\n"),
      );
      let caught: unknown;
      try {
        loadPlaybook(tree.root, "after-bad");
      } catch (error) {
        caught = error;
      }
      expect(isArgosError(caught)).toBe(true);
      if (!isArgosError(caught)) return;
      expect(caught.code).toBe("playbook_invalid");
      expect(caught.stepId).toBe("publish");
    } finally {
      tree.cleanup();
    }
  });
});

describe('"*" warns env_inherit_all (FR2.5)', () => {
  it("emits one warning for the step and keeps the entry in the IR", () => {
    const tree = tempTree();
    try {
      tree.write(".argos/playbooks/inherit.yaml", scriptPlaybook(["*"]));
      const warnings: LoadWarning[] = [];
      const ir = loadPlaybook(tree.root, "inherit", { warnings });
      expect(warnings.map((warning) => warning.code)).toStrictEqual(["env_inherit_all"]);
      expect(warnings[0]?.stepId).toBe("build");
      expect(warnings[0]?.file).toBe(join(tree.root, ".argos", "playbooks", "inherit.yaml"));
      expect(ir.steps[0]?.script?.env).toStrictEqual(["*"]);
    } finally {
      tree.cleanup();
    }
  });
});

describe("a deny-listed name warns env_denied (FR2.4)", () => {
  it.each(["ARGOS_PASEO_PASSWORD", "ARGOS_HOME", "ARGOS_FAKE_PASEO_RELEASE_FILE"])(
    "warns for %s",
    (entry) => {
      const tree = tempTree();
      try {
        tree.write(".argos/playbooks/denied.yaml", scriptPlaybook([entry]));
        const warnings: LoadWarning[] = [];
        const ir = loadPlaybook(tree.root, "denied", { warnings });
        expect(warnings.map((warning) => warning.code)).toStrictEqual(["env_denied"]);
        expect(warnings[0]?.stepId).toBe("build");
        expect(warnings[0]?.message).toContain(entry);
        // The IR still carries the entry: the runtime filter, not the IR, enforces the deny list.
        expect(ir.steps[0]?.script?.env).toStrictEqual([entry]);
      } finally {
        tree.cleanup();
      }
    },
  );

  it("warns once per deny-listed name a prefix grant covers", () => {
    const tree = tempTree();
    try {
      const { warnings } = load(tree, "denied-prefix", scriptPlaybook(["ARGOS_*"]));
      expect(warnings.every((warning) => warning.code === "env_denied")).toBe(true);
      expect(warnings.map((warning) => warning.message).join("\n")).toContain("ARGOS_PASEO_PASSWORD");
      expect(warnings).toHaveLength(8);
    } finally {
      tree.cleanup();
    }
  });

  it("does not warn for an ordinary name or an unrelated prefix", () => {
    const tree = tempTree();
    try {
      const { warnings } = load(tree, "quiet", scriptPlaybook(["MY_API_KEY", "NPM_*"]));
      expect(warnings).toStrictEqual([]);
    } finally {
      tree.cleanup();
    }
  });
});

describe("env warnings never change the load (FR7.4)", () => {
  it("keeps the IR and the hash identical with and without a sink", () => {
    const tree = tempTree();
    try {
      tree.write(".argos/playbooks/loud.yaml", scriptPlaybook(["*", "ARGOS_HOME", "NPM_*"]));
      const quiet = loadPlaybook(tree.root, "loud");
      const warnings: LoadWarning[] = [];
      const loud = loadPlaybook(tree.root, "loud", { warnings });

      expect(warnings.map((warning) => warning.code)).toStrictEqual([
        "env_inherit_all",
        "env_denied",
      ]);
      expect(loud.hash).toBe(quiet.hash);
      expect(JSON.parse(JSON.stringify(loud))).toStrictEqual(JSON.parse(JSON.stringify(quiet)));
    } finally {
      tree.cleanup();
    }
  });

  it("warns in a .paseo upstream file too (an unknown key is what the origin rule gates)", () => {
    const tree = tempTree();
    try {
      tree.write(".paseo/plugins/playbooks/upstream.yaml", scriptPlaybook(["*"]));
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, "upstream", { warnings });
      expect(warnings.map((warning) => warning.code)).toStrictEqual(["env_inherit_all"]);
    } finally {
      tree.cleanup();
    }
  });
});
