/**
 * The pack model, the ownership marker, and the pure plan (spec FR1–FR4, FR11/FR12; plan Phase 2).
 *
 * Everything here is data in, data out: the planner never reads a file, so these tests can assert
 * the *rules* (a refusal writes nothing, a second install is byte-identical, a version bump lands
 * beside the old directory) without a server, a clock, or a machine-specific path.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PackApplyError, applyInstall, applyUninstall } from "../../src/packs/apply.js";
import { PackAssetsError, bundledPacks } from "../../src/packs/bundled.js";
import {
  emptyManifest,
  markerOf,
  packMarker,
  parseManifest,
  parsePack,
  parseTemplate,
  renderTemplate,
  serializeManifest,
  type Pack,
  type PackManifest,
} from "../../src/packs/pack.js";
import {
  planInstall,
  planUninstall,
  quoteCommandArg,
  satisfiesNodeFloor,
  type DiskTemplate,
  type InstallPlan,
  type InstalledProgram,
  type PackSource,
} from "../../src/packs/plan.js";
import {
  argosStateDir,
  manifestPath,
  packInstallDir,
  templatesDir,
} from "../../src/packs/templates-dir.js";

const packsDir = fileURLToPath(new URL("../../templates/packs", import.meta.url));
const nodePath = "/opt/homebrew/bin/node";
const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readPackJson(name: string): { file: string; text: string } {
  const file = join(packsDir, name, "pack.json");
  return { file, text: readFileSync(file, "utf8") };
}

function parseBundled(name: string): Pack {
  const { file, text } = readPackJson(name);
  const parsed = parsePack(text, file);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.issues.map((i) => i.message).join(", ")}`);
  return parsed.value;
}

/** A bundled pack as the planner sees it: `pack.json` parsed, the program's bytes read. */
function bundledSource(name: string, installed?: InstalledProgram): PackSource {
  const pack = parseBundled(name);
  const dir = join(packsDir, name);
  return {
    pack,
    file: join(dir, "pack.json"),
    dir,
    source: "bundled",
    programContent: readFileSync(join(dir, pack.program.file), "utf8"),
    ...(installed === undefined ? {} : { installedProgram: installed }),
  };
}

/** The same pack, as it looks after a successful install (a copy with the same bytes). */
function installed(source: PackSource): PackSource {
  const content = must(source.programContent, "a copy install has program content");
  return { ...source, installedProgram: { sha256: sha256(content) } };
}

interface PlanOptions {
  readonly packs?: readonly PackSource[];
  readonly templates?: readonly DiskTemplate[];
  readonly manifest?: PackManifest;
  readonly link?: boolean;
  readonly force?: boolean;
  readonly nodeVersion?: string;
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly templatesDir?: string;
}

function plan(options: PlanOptions = {}): InstallPlan {
  const home = options.home ?? "/home/op/.argos";
  return planInstall({
    packs: options.packs ?? [bundledSource("claude"), bundledSource("smoke")],
    templates: options.templates ?? [],
    manifest: options.manifest ?? emptyManifest(),
    templatesDir: options.templatesDir ?? "/home/op/.config/herdr-core/templates",
    home,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    nodePath: options.nodePath ?? nodePath,
    link: options.link ?? false,
    force: options.force ?? false,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
}

/** What a completed plan leaves on disk, in the shape the next plan reads back. */
function templatesFromPlan(installPlan: InstallPlan): DiskTemplate[] {
  return installPlan.writes
    .filter((write) => write.path.endsWith(".md"))
    .map((write) => ({ name: basename(write.path, ".md"), content: write.content }));
}

function packJsonWith(mutate: (pack: Record<string, unknown>) => void): string {
  const pack = JSON.parse(readPackJson("claude").text) as Record<string, unknown>;
  mutate(pack);
  return JSON.stringify(pack);
}

// ------------------------------------------------------------------ schema

describe("pack.json schema", () => {
  it("accepts both bundled packs and their frozen template data", () => {
    const claude = parseBundled("claude");
    expect(claude.name).toBe("claude");
    expect(claude.version).toBe(1);
    expect(claude.requires.node).toBe(">=22.13");
    expect(claude.requires.hcProtocol).toBe(1);
    expect(claude.program.file).toBe("claude-step.mjs");
    expect(claude.templates.map((template) => template.name)).toEqual([
      "claude-opus-high",
      "claude-opus-xhigh",
      "claude-sonnet-medium",
      "claude-fable-high",
    ]);
    const smoke = parseBundled("smoke");
    expect(smoke.templates.map((template) => template.name)).toEqual(["smoke"]);
  });

  it("refuses an unknown key, naming the file and the field", () => {
    const file = join(packsDir, "claude", "pack.json");
    const top = parsePack(packJsonWith((pack) => void (pack["extra"] = true)), file);
    expect(top.ok).toBe(false);
    if (top.ok) throw new Error("expected a refusal");
    expect(top.issues[0]?.path).toBe(file);
    expect(top.issues[0]?.message).toContain('"extra"');

    const nested = parsePack(
      packJsonWith((pack) => void ((pack["requires"] as Record<string, unknown>)["bogus"] = 1)),
      file,
    );
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("expected a refusal");
    expect(nested.issues[0]?.path).toBe(`${file}:requires`);
    expect(nested.issues[0]?.message).toContain('"bogus"');
  });

  it("refuses a bad version, a bad step floor, a bad template name, and a nested program path", () => {
    const file = join(packsDir, "claude", "pack.json");
    const template = (pack: Record<string, unknown>, index: number): Record<string, unknown> => {
      const templates = pack["templates"] as Array<Record<string, unknown>>;
      const found = templates[index];
      if (found === undefined) throw new Error(`no template ${index}`);
      return found;
    };
    const cases: Array<[(pack: Record<string, unknown>) => void, string]> = [
      [(pack) => void (pack["version"] = 0), "version"],
      [(pack) => void (template(pack, 0)["minStepTimeoutMs"] = 0), "templates.0.minStepTimeoutMs"],
      [(pack) => void (template(pack, 0)["name"] = "Claude_Opus"), "templates.0.name"],
      [(pack) => void ((pack["program"] as Record<string, unknown>)["file"] = "../evil.mjs"), "program.file"],
    ];
    for (const [mutate, field] of cases) {
      const parsed = parsePack(packJsonWith(mutate), file);
      expect(parsed.ok, field).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues.some((issue) => issue.path === `${file}:${field}`), field).toBe(true);
    }
  });

  it("refuses two templates with one name and a malformed pack name", () => {
    const file = join(packsDir, "claude", "pack.json");
    const duplicate = parsePack(
      packJsonWith((pack) => {
        const templates = pack["templates"] as Array<Record<string, unknown>>;
        const first = templates[0]?.["name"];
        const second = templates[1];
        if (second === undefined) throw new Error("claude pack needs two templates");
        second["name"] = first;
      }),
      file,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues[0]?.message).toContain("duplicate template name");

    const badName = parsePack(packJsonWith((pack) => void (pack["name"] = "Claude Pack")), file);
    expect(badName.ok).toBe(false);
  });

  it("refuses a manifest that is not the versioned, hashed shape", () => {
    const file = "/home/op/.argos/hc/packs.json";
    const good = {
      version: 1,
      packs: {
        claude: {
          version: 1,
          source: "bundled",
          program: "/home/op/.argos/hc/packs/claude@1/claude-step.mjs",
          programSha256: "a".repeat(64),
          templates: { "claude-opus-high": { file: "/t/claude-opus-high.md", minStepTimeoutMs: 1 } },
        },
      },
    };
    expect(parseManifest(JSON.stringify(good), file).ok).toBe(true);
    const badVersion = parseManifest(JSON.stringify({ ...good, version: 2 }), file);
    expect(badVersion.ok).toBe(false);
    const badHash = parseManifest(
      JSON.stringify({ ...good, packs: { claude: { ...good.packs.claude, programSha256: "nope" } } }),
      file,
    );
    expect(badHash.ok).toBe(false);
    const notJson = parseManifest("{", file);
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.issues[0]?.message).toContain("not valid JSON");
  });
});

// ------------------------------------------------------------------ marker

describe("the ownership marker", () => {
  it("renders and parses back the fields hc reads, marker included", () => {
    expect(packMarker({ name: "claude", version: 1 })).toBe("· argos-pack claude 1");

    const command = `${quoteCommandArg(nodePath)} ${quoteCommandArg("/tmp/a'b\"c/claude-step.mjs")} --model x`;
    const text = renderTemplate({
      name: "claude-opus-high",
      description: "Headless Claude Code: effort high # not a comment",
      command,
      pack: { name: "claude", version: 1 },
    });
    expect(text.startsWith("---\nname: claude-opus-high\n")).toBe(true);
    expect(text.endsWith("---\n")).toBe(true);

    const parsed = parseTemplate(text);
    expect(parsed.name).toBe("claude-opus-high");
    expect(parsed.command).toBe(command);
    expect(parsed.description).toBe(
      "Headless Claude Code: effort high # not a comment · argos-pack claude 1",
    );
    expect(parsed.pack).toEqual({ name: "claude", version: 1 });
    expect(parsed.body).toBe("");
  });

  it("treats a file without the marker as foreign data, not an error", () => {
    const foreign = '---\nname: mine\ndescription: hand written\ncommand: echo hi\n---\nbody\n';
    const parsed = parseTemplate(foreign);
    expect(parsed.pack).toBeUndefined();
    expect(parsed.command).toBe("echo hi");
    expect(parsed.body).toBe("body\n");
    expect(markerOf("hand written")).toBeUndefined();
    expect(markerOf(undefined)).toBeUndefined();
    expect(parseTemplate("no frontmatter at all")).toEqual({ body: "no frontmatter at all" });
  });
});

// ------------------------------------------------------------------ quoting

describe("command quoting", () => {
  it("single-quotes on POSIX and double-quotes on Windows", () => {
    expect(quoteCommandArg("/opt/homebrew/bin/node", "linux")).toBe("'/opt/homebrew/bin/node'");
    expect(quoteCommandArg("C:\\Program Files\\node.exe", "win32")).toBe(
      '"C:\\Program Files\\node.exe"',
    );
    // A path holding both quote styles is escaped, never silently broken.
    expect(quoteCommandArg(`/tmp/a'b"c`, "linux")).toBe(`'/tmp/a'\\''b"c'`);
    expect(quoteCommandArg(`C:\\a "b"`, "win32")).toBe('"C:\\a \\"b\\""');
  });

  it.skipIf(process.platform === "win32")("survives a real shell with both quote styles", () => {
    const path = `/tmp/a'b"c $d \`e\`/claude-step.mjs`;
    const command = `${quoteCommandArg(nodePath)} ${quoteCommandArg(path)} --model x`;
    const printed = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${command}`], {
      encoding: "utf8",
    });
    expect(printed.split("\n").slice(0, 2)).toEqual([nodePath, path]);
  });
});

describe("node floors", () => {
  it("compares the running node against the pack's floor", () => {
    expect(satisfiesNodeFloor(">=22.13", "22.13.0")).toBe(true);
    expect(satisfiesNodeFloor(">=22.13", "22.12.9")).toBe(false);
    expect(satisfiesNodeFloor(">=22", "22.0.0")).toBe(true);
    expect(satisfiesNodeFloor(">=23", "22.13.0")).toBe(false);
    expect(satisfiesNodeFloor(">=22.13", "24.1.0")).toBe(true);
    expect(satisfiesNodeFloor("^22.13", "22.13.0")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ directories

describe("the two directories", () => {
  it("resolves the templates dir from --dir, XDG_CONFIG_HOME, then HOME", () => {
    expect(templatesDir("/custom", {}, "/home/op")).toBe("/custom");
    expect(templatesDir(undefined, { XDG_CONFIG_HOME: "/xdg" }, "/home/op")).toBe(
      "/xdg/herdr-core/templates",
    );
    expect(templatesDir(undefined, {}, "/home/op")).toBe("/home/op/.config/herdr-core/templates");
    expect(templatesDir(undefined, { XDG_CONFIG_HOME: "  " }, "/home/op")).toBe(
      "/home/op/.config/herdr-core/templates",
    );
  });

  it("keeps Argos' own state under $ARGOS_HOME", () => {
    expect(argosStateDir({ ARGOS_HOME: "/state" }, "/home/op")).toBe("/state");
    expect(argosStateDir({}, "/home/op")).toBe("/home/op/.argos");
    expect(manifestPath("/state")).toBe("/state/hc/packs.json");
    expect(packInstallDir("/state", "claude", 2)).toBe("/state/hc/packs/claude@2");
  });

  it("finds the bundled packs and refuses an incomplete installation", () => {
    const bundled = bundledPacks();
    expect(bundled.dir).toBe(packsDir);
    expect(bundled.names).toEqual(["claude", "smoke"]);
    expect(() => bundledPacks(join(tempDir("argos-packs-"), "missing"))).toThrow(PackAssetsError);
  });
});

// ------------------------------------------------------------------ install plan

describe("planInstall", () => {
  it("writes the programs, the templates, and the manifest for a fresh install", () => {
    const installPlan = plan();
    const templateWrites = installPlan.writes.filter((write) => write.path.endsWith(".md"));
    expect(templateWrites).toHaveLength(5);
    expect(templateWrites.map((write) => basename(write.path)).sort()).toEqual([
      "claude-fable-high.md",
      "claude-opus-high.md",
      "claude-opus-xhigh.md",
      "claude-sonnet-medium.md",
      "smoke.md",
    ]);
    for (const write of templateWrites) expect(write.mode).toBe(0o644);
    const programWrites = installPlan.writes.filter((write) => write.path.endsWith(".mjs"));
    expect(programWrites.map((write) => write.path)).toEqual([
      "/home/op/.argos/hc/packs/claude@1/claude-step.mjs",
      "/home/op/.argos/hc/packs/smoke@1/smoke.mjs",
    ]);
    for (const write of programWrites) expect(write.mode).toBe(0o700);

    const entry = must(installPlan.manifest.packs["claude"], "claude is in the manifest");
    expect(entry.version).toBe(1);
    expect(entry.source).toBe("bundled");
    expect(entry.program).toBe("/home/op/.argos/hc/packs/claude@1/claude-step.mjs");
    expect(entry.programSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.link).toBeUndefined();
    expect(Object.keys(entry.templates).sort()).toEqual([
      "claude-fable-high",
      "claude-opus-high",
      "claude-opus-xhigh",
      "claude-sonnet-medium",
    ]);
    expect(must(entry.templates["claude-opus-high"], "template").minStepTimeoutMs).toBe(19_800_000);

    const md = must(
      templateWrites.find((write) => write.path.endsWith("claude-opus-high.md")),
      "claude-opus-high.md",
    ).content;
    expect(md).toContain(`'${nodePath}'`);
    expect(md).toContain("'/home/op/.argos/hc/packs/claude@1/claude-step.mjs'");
    expect(md).toContain("--model claude-opus-5-5");
    expect(parseTemplate(md).pack).toEqual({ name: "claude", version: 1 });

    expect(installPlan.unchanged).toBe(false);
    expect(installPlan.refusals).toEqual([]);
    expect(installPlan.manifestWrite?.path).toBe("/home/op/.argos/hc/packs.json");
    expect(installPlan.manifestWrite?.mode).toBe(0o600);
    expect(installPlan.manifestWrite?.content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("is idempotent: the same plan applied twice is no write at all", () => {
    const first = plan();
    const second = plan({
      packs: [installed(bundledSource("claude")), installed(bundledSource("smoke"))],
      templates: templatesFromPlan(first),
      manifest: first.manifest,
    });
    expect(second.writes).toEqual([]);
    expect(second.links).toEqual([]);
    expect(second.manifestWrite).toBeUndefined();
    expect(second.unchanged).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("installs a version bump beside the old directory and re-stamps the templates", () => {
    const first = plan({ packs: [bundledSource("claude")] });
    const bumped = parseBundled("claude");
    const second = plan({
      packs: [{ ...bundledSource("claude"), pack: { ...bumped, version: 2 } }],
      templates: templatesFromPlan(first),
      manifest: first.manifest,
    });
    expect(second.writes.map((write) => write.path)).toContain(
      "/home/op/.argos/hc/packs/claude@2/claude-step.mjs",
    );
    expect(second.writes.some((write) => write.path.includes("claude@1"))).toBe(false);
    expect(must(second.manifest.packs["claude"], "claude").version).toBe(2);
    const md = must(
      second.writes.find((write) => write.path.endsWith("claude-opus-high.md")),
      "rewritten template",
    ).content;
    expect(md).toContain("· argos-pack claude 2");
    expect(md).toContain("claude@2");
  });

  it("refuses a foreign .md and produces no write at all", () => {
    const foreign: DiskTemplate = {
      name: "smoke",
      content: "---\nname: smoke\ndescription: mine\ncommand: echo hi\n---\n",
    };
    const refused = plan({ packs: [bundledSource("smoke")], templates: [foreign] });
    expect(refused.refusals.map((refusal) => refusal.code)).toEqual(["template_conflict"]);
    expect(refused.refusals[0]?.message).toContain("smoke.md");
    expect(refused.refusals[0]?.message).toContain("--force");
    expect(refused.writes).toEqual([]);
    expect(refused.links).toEqual([]);
    expect(refused.manifestWrite).toBeUndefined();
    expect(refused.manifest).toEqual(emptyManifest());

    const forced = plan({ packs: [bundledSource("smoke")], templates: [foreign], force: true });
    expect(forced.refusals).toEqual([]);
    const write = must(
      forced.writes.find((candidate) => candidate.path.endsWith("smoke.md")),
      "forced write",
    );
    expect(parseTemplate(write.content).pack).toEqual({ name: "smoke", version: 1 });
  });

  it("refuses to let two packs own one template name, or a pack take another's file", () => {
    const smoke = bundledSource("smoke");
    const impostor: PackSource = {
      ...bundledSource("smoke"),
      pack: { ...smoke.pack, name: "other" },
    };
    const clash = plan({ packs: [smoke, impostor] });
    expect(clash.refusals.map((refusal) => refusal.code)).toEqual(["template_conflict"]);

    const sameName = plan({
      packs: [bundledSource("smoke")],
      templates: [
        {
          name: "smoke",
          content: renderTemplate({
            name: "smoke",
            description: "someone else",
            command: "echo",
            pack: { name: "claude", version: 1 },
          }),
        },
      ],
    });
    expect(sameName.refusals.map((refusal) => refusal.code)).toEqual(["template_conflict"]);
    expect(sameName.refusals[0]?.message).toContain('pack "claude"');
  });

  it("refuses an unsupported protocol, an old node, and an unreadable floor", () => {
    const claude = bundledSource("claude");
    const protocol = plan({
      packs: [{ ...claude, pack: { ...claude.pack, requires: { ...claude.pack.requires, hcProtocol: 2 } } }],
    });
    expect(protocol.refusals.map((refusal) => refusal.code)).toEqual(["unsupported_protocol"]);

    const oldNode = plan({ packs: [claude], nodeVersion: "22.12.0" });
    expect(oldNode.refusals.map((refusal) => refusal.code)).toEqual(["node_too_old"]);

    const unknownFloor = plan({
      packs: [
        {
          ...claude,
          pack: { ...claude.pack, requires: { ...claude.pack.requires, node: "latest" } },
        },
      ],
    });
    expect(unknownFloor.refusals.map((refusal) => refusal.code)).toEqual(["invalid_floor"]);
    for (const refused of [protocol, oldNode, unknownFloor]) expect(refused.writes).toEqual([]);
  });

  it("warns about hc and claude floors instead of blocking on them", () => {
    const claude = bundledSource("claude");
    const warned = plan({
      packs: [
        {
          ...claude,
          pack: { ...claude.pack, requires: { ...claude.pack.requires, hc: ">=0.1.21", claude: ">=2.0" } },
        },
      ],
    });
    expect(warned.refusals).toEqual([]);
    expect(warned.warnings).toHaveLength(2);
    expect(warned.warnings.join("\n")).toContain("hc >=0.1.21");
    expect(warned.warnings.join("\n")).toContain("claude >=2.0");
  });

  it("links the program instead of copying it, and refuses --link on Windows", () => {
    const linked = plan({ packs: [bundledSource("smoke")], link: true });
    expect(linked.writes.some((write) => write.path.endsWith(".mjs"))).toBe(false);
    expect(linked.links).toEqual([
      {
        path: "/home/op/.argos/hc/packs/smoke@1/smoke.mjs",
        target: join(packsDir, "smoke", "smoke.mjs"),
      },
    ]);
    const entry = must(linked.manifest.packs["smoke"], "smoke");
    expect(entry.link).toBe(join(packsDir, "smoke", "smoke.mjs"));
    expect(entry.programSha256).toBeUndefined();
    const md = must(
      linked.writes.find((write) => write.path.endsWith("smoke.md")),
      "smoke.md",
    ).content;
    expect(md).toContain(join(packsDir, "smoke", "smoke.mjs"));

    const windows = plan({ packs: [bundledSource("smoke")], link: true, platform: "win32" });
    expect(windows.refusals.map((refusal) => refusal.code)).toEqual(["link_unsupported"]);
  });

  it("is unchanged when only the manifest source label moved", () => {
    const first = plan({ packs: [bundledSource("smoke")] });
    const again = plan({
      packs: [installed({ ...bundledSource("smoke"), source: "bundled" })],
      templates: templatesFromPlan(first),
      manifest: first.manifest,
    });
    expect(again.unchanged).toBe(true);
  });
});

// ------------------------------------------------------------------ uninstall plan

describe("planUninstall", () => {
  const templatesDirPath = "/home/op/.config/herdr-core/templates";

  function installedBoth(): InstallPlan {
    return plan();
  }

  it("removes only marker files and drops the manifest entry", () => {
    const installPlan = installedBoth();
    const foreign: DiskTemplate = {
      name: "hand-written",
      content: "---\nname: hand-written\ncommand: echo hi\n---\n",
    };
    const uninstall = planUninstall({
      packs: ["claude"],
      templates: [...templatesFromPlan(installPlan), foreign],
      manifest: installPlan.manifest,
      templatesDir: templatesDirPath,
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1", "smoke@1"],
      prune: false,
    });
    expect(uninstall.refusals).toEqual([]);
    expect(uninstall.removes.filter((remove) => remove.kind === "template")).toHaveLength(4);
    expect(uninstall.manifest.packs["claude"]).toBeUndefined();
    expect(uninstall.manifest.packs["smoke"]).toBeDefined();
    expect(uninstall.keeps.map((keep) => basename(keep.path))).toEqual(["claude@1"]);
    expect(uninstall.unchanged).toBe(false);
  });

  it("keeps a file whose content is not ours, or was moved, or is gone", () => {
    const installPlan = installedBoth();
    const templates = templatesFromPlan(installPlan).map((template) =>
      template.name === "claude-opus-high"
        ? { ...template, content: "---\nname: claude-opus-high\ndescription: mine\n---\n" }
        : template,
    );
    const uninstall = planUninstall({
      packs: ["claude"],
      templates: templates.filter((template) => template.name !== "claude-fable-high"),
      manifest: installPlan.manifest,
      templatesDir: templatesDirPath,
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1", "smoke@1"],
      prune: false,
    });
    const kept = uninstall.keeps.map((keep) => `${basename(keep.path)}: ${keep.reason}`);
    expect(kept).toContain("claude-opus-high.md: not an argos pack template");
    expect(kept).toContain("claude-fable-high.md: missing");
    expect(uninstall.removes.map((remove) => basename(remove.path)).sort()).toEqual([
      "claude-opus-xhigh.md",
      "claude-sonnet-medium.md",
    ]);

    const moved = planUninstall({
      packs: ["smoke"],
      templates: templatesFromPlan(installPlan),
      manifest: installPlan.manifest,
      templatesDir: "/elsewhere/templates",
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1", "smoke@1"],
      prune: false,
    });
    expect(moved.removes).toEqual([]);
    expect(moved.keeps[0]?.reason).toContain("moved");
    expect(moved.manifest.packs["smoke"]).toBeUndefined();
  });

  it("prunes only unreferenced pack directories that Argos named", () => {
    const installPlan = installedBoth();
    const uninstall = planUninstall({
      packs: ["claude"],
      templates: templatesFromPlan(installPlan),
      manifest: installPlan.manifest,
      templatesDir: templatesDirPath,
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1", "smoke@1", "not-a-pack", "claude@0"],
      prune: true,
    });
    expect(
      uninstall.removes.filter((remove) => remove.kind === "pack").map((remove) => remove.path),
    ).toEqual([
      "/home/op/.argos/hc/packs/claude@0",
      "/home/op/.argos/hc/packs/claude@1",
    ]);
    // `claude@0` matches the `<name>@<version>` shape and is unreferenced, so it is a candidate;
    // `not-a-pack` is not ours to delete.
    expect(uninstall.removes.some((remove) => remove.path.endsWith("not-a-pack"))).toBe(false);

    const kept = planUninstall({
      packs: ["claude"],
      templates: templatesFromPlan(installPlan),
      manifest: installPlan.manifest,
      templatesDir: templatesDirPath,
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1"],
      prune: false,
    });
    expect(kept.removes.every((remove) => remove.kind === "template")).toBe(true);
    expect(kept.keeps.map((keep) => keep.reason)).toContain("program dir (pass --prune to remove)");
  });

  it("refuses an unknown pack and produces no removal at all", () => {
    const installPlan = installedBoth();
    const uninstall = planUninstall({
      packs: ["nope"],
      templates: templatesFromPlan(installPlan),
      manifest: installPlan.manifest,
      templatesDir: templatesDirPath,
      home: "/home/op/.argos",
      existingPackDirs: ["claude@1", "smoke@1"],
      prune: true,
    });
    expect(uninstall.refusals.map((refusal) => refusal.code)).toEqual(["pack_unknown"]);
    expect(uninstall.removes).toEqual([]);
    expect(uninstall.manifestWrite).toBeUndefined();
    expect(uninstall.manifest).toEqual(installPlan.manifest);
  });
});

// ------------------------------------------------------------------ apply

describe("apply", () => {
  function roots(): { root: string; home: string; templates: string } {
    const root = tempDir("argos-pack-apply-");
    return {
      root,
      home: join(root, "argos"),
      templates: join(root, "xdg", "herdr-core", "templates"),
    };
  }

  function snapshot(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string): void => {
      if (!existsSync(current)) return;
      for (const entry of readdirSync(current).sort()) {
        const path = join(current, entry);
        const stat = lstatSync(path);
        if (stat.isDirectory()) walk(path);
        else found.push(`${path}:${stat.mode & 0o777}:${readFileSync(path, "utf8").length}`);
      }
    };
    walk(dir);
    return found.sort();
  }

  it("applies exactly the plan it printed, manifest last", () => {
    const { home, templates } = roots();
    const installPlan = plan({ home, templatesDir: templates });
    const result = applyInstall(installPlan, { home, templatesDir: templates });
    expect(result.unchanged).toBe(false);
    expect(result.written).toEqual([
      ...installPlan.writes.map((write) => write.path),
      must(installPlan.manifestWrite, "manifest write").path,
    ]);
    for (const write of installPlan.writes) {
      expect(readFileSync(write.path, "utf8"), write.path).toBe(write.content);
      expect(lstatSync(write.path).mode & 0o777, write.path).toBe(write.mode);
    }
    expect(lstatSync(join(home, "hc", "packs", "claude@1")).mode & 0o777).toBe(0o700);
    expect(lstatSync(must(installPlan.manifestWrite, "manifest").path).mode & 0o777).toBe(0o600);

    // The second plan reads the installed state back and writes nothing.
    const second = plan({
      home,
      templatesDir: templates,
      packs: [installed(bundledSource("claude")), installed(bundledSource("smoke"))],
      templates: readdirSync(templates)
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => ({
          name: basename(entry, ".md"),
          content: readFileSync(join(templates, entry), "utf8"),
        })),
      manifest: installPlan.manifest,
    });
    expect(second.unchanged).toBe(true);
    const before = snapshot(home);
    const applied = applyInstall(second, { home, templatesDir: templates });
    expect(applied.written).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  it("writes nothing when the plan refused", () => {
    const { root, home, templates } = roots();
    mkdirSync(templates, { recursive: true });
    writeFileSync(join(templates, "smoke.md"), "---\nname: smoke\n---\n");
    chmodSync(join(templates, "smoke.md"), 0o644);
    const before = snapshot(root);
    const refused = plan({
      home,
      templatesDir: templates,
      packs: [bundledSource("smoke")],
      templates: [{ name: "smoke", content: readFileSync(join(templates, "smoke.md"), "utf8") }],
    });
    expect(refused.refusals).not.toEqual([]);
    applyInstall(refused, { home, templatesDir: templates });
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses to touch a path outside the two directories", () => {
    const { root, home, templates } = roots();
    const outside = join(root, "outside.txt");
    const installPlan = plan({ home, templatesDir: templates });
    expect(() =>
      applyInstall(
        { ...installPlan, writes: [{ path: outside, content: "x", mode: 0o600 }] },
        { home, templatesDir: templates },
      ),
    ).toThrow(PackApplyError);
    expect(existsSync(outside)).toBe(false);
  });

  it("removes a marker file and a pruned pack directory", () => {
    const { home, templates } = roots();
    const installPlan = plan({ home, templatesDir: templates });
    applyInstall(installPlan, { home, templatesDir: templates });
    const uninstall = planUninstall({
      packs: ["claude"],
      templates: readdirSync(templates)
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => ({ name: basename(entry, ".md"), content: readFileSync(join(templates, entry), "utf8") })),
      manifest: installPlan.manifest,
      templatesDir: templates,
      home,
      existingPackDirs: readdirSync(join(home, "hc", "packs")),
      prune: true,
    });
    const result = applyUninstall(uninstall, { home, templatesDir: templates });
    expect(result.removed).toContain(join(templates, "claude-opus-high.md"));
    expect(existsSync(join(templates, "claude-opus-high.md"))).toBe(false);
    expect(existsSync(join(templates, "smoke.md"))).toBe(true);
    expect(existsSync(join(home, "hc", "packs", "claude@1"))).toBe(false);
    expect(existsSync(join(home, "hc", "packs", "smoke@1"))).toBe(true);
    expect(serializeManifest(uninstall.manifest)).not.toContain('"claude"');
  });
});
