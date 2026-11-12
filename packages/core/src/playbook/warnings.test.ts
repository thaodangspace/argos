/**
 * FR7 warnings: alias conflicts name the spelling Argos keeps, deprecated spellings warn only in
 * `.argos/` and home files, no warning ever carries a YAML value, and the IR/hash never depend on
 * whether a sink was passed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ValidateWarningCodeSchema } from "../rpc/contracts.js";
import { loadPlaybook, type LoadWarning } from "./load.js";
import { WARNING_CODES } from "./resolve.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const ALIASES = join(FIXTURES, "aliases");

interface TempTree {
  readonly root: string;
  write(relativePath: string, body: string): string;
  cleanup(): void;
}

function tempTree(): TempTree {
  const root = mkdtempSync(join(tmpdir(), "argos-warn-"));
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

/** Messages only; the file/step id are asserted where they matter. */
function messages(warnings: readonly LoadWarning[]): string[] {
  return warnings.map((warning) => warning.message);
}

describe("alias_conflict names the spelling Argos keeps (FR7.2)", () => {
  it.each([
    {
      id: "conflict-poll",
      body: [
        "title: Poll conflict",
        "steps:",
        "  - id: work",
        "    prompt: Work",
        "    pollMs: 10",
        "    poll_ms: 20",
        '    poll: "30s"',
        "",
      ].join("\n"),
      kept: '"pollMs"',
    },
    {
      id: "conflict-mode",
      body: [
        "title: Mode conflict",
        "steps:",
        "  - id: work",
        "    prompt: Work",
        "    agent: { provider: claude, model: opus, mode_id: plan, mode: acceptEdits }",
        "",
      ].join("\n"),
      kept: '"mode_id"',
    },
    {
      id: "conflict-choices",
      body: [
        "title: Choices conflict",
        "steps:",
        "  - id: decide",
        "    gate:",
        "      question: Ship it?",
        "      choices: { approved: { label: Approve } }",
        "    choices: [ship, hold]",
        "",
      ].join("\n"),
      kept: '"choices"',
    },
    {
      id: "conflict-script-env",
      body: [
        "title: Script env conflict",
        "steps:",
        "  - id: work",
        "    script:",
        "      run: build.mjs",
        "      env: [FROM_BLOCK]",
        "    env: [FROM_STEP]",
        "",
      ].join("\n"),
      kept: '"script.env"',
    },
    {
      id: "conflict-use",
      body: ["title: Use conflict", "steps:", "  - id: work", "    use: child", "    playbook: child", ""].join("\n"),
      kept: '"use"',
    },
  ])("$id: $kept wins", ({ id, body, kept }) => {
    const tree = tempTree();
    try {
      tree.write(`.argos/playbooks/${id}.yaml`, body);
      tree.write(
        ".argos/playbooks/child.yaml",
        "title: Child\nsteps:\n  - id: inner\n    prompt: Inner\n",
      );
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, id, { warnings });

      const conflicts = warnings.filter((warning) => warning.code === "alias_conflict");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.stepId).toBe(id === "conflict-choices" ? "decide" : "work");
      expect(conflicts[0]?.message).toContain(`Argos keeps ${kept}`);
      expect(conflicts[0]?.file).toBe(join(tree.root, ".argos", "playbooks", `${id}.yaml`));
    } finally {
      tree.cleanup();
    }
  });
});

describe("alias_deprecated is scoped to .argos and home files (FR7.2)", () => {
  const BODY = [
    "title: Deprecated spellings",
    "steps:",
    "  - id: work",
    "    prompt: Work",
    "    poll_ms: 10",
    "    agent: { provider: claude, model: opus, mode_id: plan }",
    "",
  ].join("\n");

  it("warns for poll_ms and mode_id in an .argos playbook", () => {
    const tree = tempTree();
    try {
      tree.write(".argos/playbooks/deprecated.yaml", BODY);
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, "deprecated", { warnings });
      expect(warnings.map((warning) => warning.code)).toStrictEqual([
        "alias_deprecated",
        "alias_deprecated",
      ]);
      expect(messages(warnings).join("\n")).toContain('"poll_ms"');
      expect(messages(warnings).join("\n")).toContain('"mode_id"');
    } finally {
      tree.cleanup();
    }
  });

  it("stays silent for the same spellings in a .paseo upstream file", () => {
    const tree = tempTree();
    try {
      tree.write(".paseo/plugins/playbooks/deprecated.yaml", BODY);
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, "deprecated", { warnings });
      expect(warnings).toStrictEqual([]);
    } finally {
      tree.cleanup();
    }
  });

  it("warns for a home playbook, which follows .argos rules", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      home.write("playbooks/global.yaml", BODY);
      const warnings: LoadWarning[] = [];
      loadPlaybook(repo.root, "global", { home: home.root, warnings });
      expect(warnings.map((warning) => warning.code)).toStrictEqual([
        "alias_deprecated",
        "alias_deprecated",
      ]);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("flags both the conflict and the deprecated spelling", () => {
    const tree = tempTree();
    try {
      tree.write(
        ".argos/playbooks/both.yaml",
        "title: Both\nsteps:\n  - id: work\n    prompt: Work\n    pollMs: 10\n    poll_ms: 20\n",
      );
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, "both", { warnings });
      expect(warnings.map((warning) => warning.code)).toStrictEqual([
        "alias_conflict",
        "alias_deprecated",
      ]);
    } finally {
      tree.cleanup();
    }
  });
});

describe("warnings never contain a YAML value (FR7.3)", () => {
  it("names the keys, not the sentinel values around them", () => {
    const tree = tempTree();
    try {
      tree.write(
        ".argos/playbooks/sentinel.yaml",
        [
          "title: SentinelTitle",
          "steps:",
          "  - id: work",
          "    prompt: SentinelPrompt",
          "    pollMs: 4242",
          "    poll_ms: 2424",
          "    agent: { provider: sentinelProvider, model: sentinelModel, mode_id: SentinelMode, mode: SentinelMode2 }",
          "",
        ].join("\n"),
      );
      const warnings: LoadWarning[] = [];
      loadPlaybook(tree.root, "sentinel", { warnings });

      expect(warnings.length).toBeGreaterThan(0);
      const text = JSON.stringify(warnings);
      for (const value of [
        "SentinelTitle",
        "SentinelPrompt",
        "sentinelProvider",
        "sentinelModel",
        "SentinelMode",
        "4242",
        "2424",
      ]) {
        expect(text).not.toContain(value);
      }
    } finally {
      tree.cleanup();
    }
  });
});

describe("the sink never changes the load (FR7.4)", () => {
  it("keeps the IR and the hash identical with and without warnings", () => {
    const quiet = loadPlaybook(ALIASES, "aliases");
    const warnings: LoadWarning[] = [];
    const loud = loadPlaybook(ALIASES, "aliases", { warnings });

    expect(warnings.length).toBeGreaterThan(0);
    expect(loud.hash).toBe(quiet.hash);
    expect(JSON.parse(JSON.stringify(loud))).toStrictEqual(JSON.parse(JSON.stringify(quiet)));
  });

  it("emits only codes the RPC contract knows (FR7.2)", () => {
    expect([...WARNING_CODES].sort()).toStrictEqual([...ValidateWarningCodeSchema.options].sort());
    const warnings: LoadWarning[] = [];
    loadPlaybook(ALIASES, "aliases", { warnings });
    for (const warning of warnings) {
      expect(ValidateWarningCodeSchema.safeParse(warning.code).success).toBe(true);
    }
  });
});
