import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { discoverPlaybooks, discoverRoles, discoverScripts, loadPlaybook } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const COMPAT = join(FIXTURES, "compat");

/** A scratch directory tree used as either a repository root or an `$ARGOS_HOME`. */
interface TempTree {
  readonly root: string;
  write(relativePath: string, body: string): string;
  cleanup(): void;
}

function tempTree(): TempTree {
  const root = mkdtempSync(join(tmpdir(), "argos-load-"));
  return {
    root,
    write(relativePath: string, body: string): string {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const SIMPLE = (title: string): string => `title: ${title}\nsteps:\n  - id: a\n    prompt: Do A\n`;


describe("loadPlaybook: golden compat fixtures (D13)", () => {
  it.each([
    { id: "pr", steps: ["investigate", "implement", "review", "local_qa", "babysit"] },
    { id: "docs", steps: ["investigate", "write", "review", "consistency", "verdict", "approve"] },
  ])("loads $id twice with an identical hash and a JSON-stable IR", ({ id, steps }) => {
    const first = loadPlaybook(COMPAT, id);
    const second = loadPlaybook(COMPAT, id);

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(second.hash);
    expect([...first.steps.map((step) => step.id)]).toStrictEqual(steps);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
  });

  it("loads the compat fixtures from the .paseo/plugins/playbooks fallback", () => {
    const entries = discoverPlaybooks(COMPAT);
    expect(entries.map((entry) => entry.id)).toStrictEqual(["docs", "pr"]);
    for (const entry of entries) expect(entry.root).toBe(".paseo/plugins/playbooks");
  });

  it("resolves role instructions, agent defaults, and the mode alias", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const implement = ir.steps.find((step) => step.id === "implement");

    expect(implement?.role?.id).toBe("implementer");
    expect(implement?.role?.readonly).toBe(false);
    expect(implement?.role?.instructions).toContain("Implementer of a pull-request playbook");
    // defaults/main.yaml `agent: { tier: worker, mode: bypassPermissions }`
    expect(implement?.agent).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
    });
    expect(implement?.timeout).toBe("1h");
    expect(implement?.retries).toBe(1);
  });

  it("wires inputs from playbook inputs and earlier step outputs", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const implement = ir.steps.find((step) => step.id === "implement");

    expect(implement?.inputs).toStrictEqual({
      request: { from: "playbook", name: "request" },
      plan: { from: "step", stepId: "investigate", output: "plan" },
      base_branch: { from: "playbook", name: "base_branch" },
    });
    const babysit = ir.steps.find((step) => step.id === "babysit");
    expect(babysit?.inputs).toStrictEqual({
      pr_url: { from: "step", stepId: "implement", output: "pr_url" },
      review: { from: "step", stepId: "review", output: "findings" },
      qa: { from: "step", stepId: "local_qa", output: "report" },
    });
  });

  it("keeps the gate choices and goto loop of the compat fixtures", () => {
    const docs = loadPlaybook(COMPAT, "docs");
    const approve = docs.steps.find((step) => step.id === "approve");
    const verdict = docs.steps.find((step) => step.id === "verdict");

    expect(approve?.kind).toBe("gate");
    expect(Object.keys(approve?.gate?.choices ?? {})).toStrictEqual(["approved", "rejected"]);
    expect(approve?.on["rejected"]).toStrictEqual({ kind: "goto", target: "write" });
    expect(verdict?.on["changes_requested"]).toStrictEqual({
      kind: "goto",
      target: "write",
      maxLoops: 2,
    });
  });

  it("freezes the IR deeply", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.steps)).toBe(true);
    expect(Object.isFrozen(ir.steps[0])).toBe(true);
    expect(Object.isFrozen(ir.steps[0]?.needs)).toBe(true);
    expect(Object.isFrozen(ir.roles)).toBe(true);
  });
});

describe("discovery", () => {
  it("prefers .argos and falls back to .paseo/plugins/playbooks per id", () => {
    const dir = join(FIXTURES, "discovery");
    const entries = discoverPlaybooks(dir);
    expect(entries.map((entry) => entry.id)).toStrictEqual(["alpha", "beta"]);
    expect(entries[0]?.root).toBe(".argos/playbooks");
    expect(entries[1]?.root).toBe(".paseo/plugins/playbooks");
    expect(loadPlaybook(dir, "alpha").title).toBe("Argos Alpha");
    expect(loadPlaybook(dir, "beta").title).toBe("Paseo Beta");
  });

  it("discovers role directories and script directories", () => {
    const roles = discoverRoles(COMPAT);
    expect(roles.map((role) => role.id)).toContain("implementer");
    expect(roles.find((role) => role.id === "implementer")?.instructionsFile).toContain("implementer");
    expect(discoverScripts(COMPAT)).toStrictEqual([]);
  });

  it("reports an unknown playbook id as playbook_missing", () => {
    try {
      loadPlaybook(COMPAT, "nope");
      throw new Error("expected loadPlaybook to throw");
    } catch (error) {
      expect(isArgosError(error)).toBe(true);
      if (!isArgosError(error)) return;
      expect(error.code).toBe("playbook_missing");
      expect(error.message).toContain("nope");
    }
  });

  it("loads an explicit file path", () => {
    const file = join(COMPAT, ".paseo/plugins/playbooks/pr.yaml");
    expect(readFileSync(file, "utf8")).toContain("title: Pull request");
    expect(loadPlaybook(COMPAT, "pr", { file }).title).toBe("Pull request");
  });
});

describe("global workflows in $ARGOS_HOME", () => {
  it("loads a playbook that exists only under the home, and stays repo-only without one", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      const file = home.write("playbooks/global.yaml", SIMPLE("Global"));
      expect(discoverPlaybooks(repo.root)).toStrictEqual([]);
      expect(discoverPlaybooks(repo.root, home.root)).toStrictEqual([
        { id: "global", file, root: join(home.root, "playbooks") },
      ]);
      expect(loadPlaybook(repo.root, "global", { home: home.root }).title).toBe("Global");
      // Without `home`, discovery stays repo-only: no real `~/.argos` can leak into a caller.
      expect(() => loadPlaybook(repo.root, "global")).toThrow(/unknown playbook/);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("keeps the repository copy when the id also exists in the home", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      repo.write(".argos/playbooks/dup.yaml", SIMPLE("Repo Dup"));
      home.write("playbooks/dup.yaml", SIMPLE("Global Dup"));
      const entries = discoverPlaybooks(repo.root, home.root);
      expect(entries.map((entry) => entry.id)).toStrictEqual(["dup"]);
      expect(entries[0]?.root).toBe(".argos/playbooks");
      expect(loadPlaybook(repo.root, "dup", { home: home.root }).title).toBe("Repo Dup");
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("does not register an id twice when the home root is the repo root", () => {
    const repo = tempTree();
    try {
      repo.write(".argos/playbooks/only.yaml", SIMPLE("Only"));
      const entries = discoverPlaybooks(repo.root, join(repo.root, ".argos"));
      expect(entries.map((entry) => entry.id)).toStrictEqual(["only"]);
    } finally {
      repo.cleanup();
    }
  });

  it("resolves a sub-playbook and a role from the home", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      home.write(
        "playbooks/parent.yaml",
        [
          "title: Parent",
          "steps:",
          "  - id: block",
          "    use: child",
          "  - id: finish",
          "    prompt: Finish",
          "    needs: [block]",
          "    role: globaler",
          "",
        ].join("\n"),
      );
      home.write("playbooks/child.yaml", SIMPLE("Child"));
      home.write("roles/globaler/role.yaml", "title: Globaler\n");
      home.write("roles/globaler/instructions.md", "Global instructions.");
      const ir = loadPlaybook(repo.root, "parent", { home: home.root });
      expect(ir.steps.map((step) => step.id)).toStrictEqual(["block.a", "finish"]);
      const finish = ir.steps.find((step) => step.id === "finish");
      expect(finish?.role?.id).toBe("globaler");
      expect(finish?.role?.instructions).toContain("Global instructions.");
      expect(discoverRoles(repo.root, home.root).map((role) => role.id)).toContain("globaler");
      expect(discoverRoles(repo.root).map((role) => role.id)).toStrictEqual([]);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("takes defaults from the home only when the repository has none", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      home.write(
        "defaults/main.yaml",
        "agent:\n  provider: home-provider\n  model: home-model\n",
      );
      home.write("playbooks/styled.yaml", SIMPLE("Styled"));
      expect(loadPlaybook(repo.root, "styled", { home: home.root }).steps[0]?.agent).toMatchObject({
        provider: "home-provider",
        model: "home-model",
      });
      repo.write(
        ".argos/defaults/main.yaml",
        "agent:\n  provider: repo-provider\n  model: repo-model\n",
      );
      expect(loadPlaybook(repo.root, "styled", { home: home.root }).steps[0]?.agent).toMatchObject({
        provider: "repo-provider",
        model: "repo-model",
      });
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("skips a missing home directory and names it in every playbook_missing message", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      const missing = join(home.root, "not-there");
      expect(discoverPlaybooks(repo.root, missing)).toStrictEqual([]);
      try {
        loadPlaybook(repo.root, "nope", { home: missing });
        throw new Error("expected loadPlaybook to throw");
      } catch (error) {
        expect(isArgosError(error) && error.code).toBe("playbook_missing");
        const message = (error as Error).message;
        expect(message).toContain(".argos/playbooks");
        expect(message).toContain(".paseo/plugins/playbooks");
        expect(message).toContain(join(missing, "playbooks"));
      }

      const parent = home.write(
        "playbooks/orphan.yaml",
        "title: Orphan\nsteps:\n  - id: block\n    use: absent-child\n",
      );
      try {
        loadPlaybook(repo.root, "orphan", { home: home.root });
        throw new Error("expected loadPlaybook to throw");
      } catch (error) {
        expect(isArgosError(error) && error.code).toBe("playbook_missing");
        const message = (error as Error).message;
        expect(message).toContain("absent-child");
        expect(message).toContain(join(home.root, "playbooks"));
        expect(isArgosError(error) ? error.file : undefined).toBe(parent);
      }
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it("discovers home scripts after the repository roots", () => {
    const repo = tempTree();
    const home = tempTree();
    try {
      const global = home.write("scripts/build.mjs", "#!/usr/bin/env node\n");
      expect(discoverScripts(repo.root, home.root)).toStrictEqual([
        { name: "build.mjs", file: global, root: join(home.root, "scripts") },
      ]);
      expect(discoverScripts(repo.root)).toStrictEqual([]);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});
