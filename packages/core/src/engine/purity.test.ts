import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Purity guard: the engine is the only layer allowed to decide control flow, and it must stay
 * free of I/O, clocks, timers, randomness, and the durable/Paseo layers so it can be replayed and
 * tested without a process. This test is the enforcement, not the comment.
 */
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCES = ["record.ts", "ready.ts", "transition.ts", "loops.ts", "timeouts.ts", "reducer.ts"] as const;

const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "node: import", pattern: /from\s+["']node:/ },
  { name: "durable layer", pattern: /from\s+["'][^"']*\/durable\// },
  { name: "paseo layer", pattern: /from\s+["'][^"']*\/paseo\// },
  { name: "timer", pattern: /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/ },
  { name: "clock read", pattern: /\b(Date\.now|new\s+Date|performance\.now)\s*\(/ },
  { name: "randomness", pattern: /\bMath\.random\s*\(/ },
  { name: "network", pattern: /\bfetch\s*\(/ },
  { name: "process env", pattern: /\bprocess\.(env|argv|cwd|pid)\b/ },
];

describe("engine purity", () => {
  for (const file of SOURCES) {
    it(`${file} imports no I/O, timers, clocks, randomness, durable, or paseo`, () => {
      const source = readFileSync(join(ENGINE_DIR, file), "utf8");
      for (const rule of FORBIDDEN) {
        expect(source, `${file}: ${rule.name}`).not.toMatch(rule.pattern);
      }
    });
  }

  it("only imports local modules, zod, and the frozen playbook/errors contract", () => {
    for (const file of SOURCES) {
      const source = readFileSync(join(ENGINE_DIR, file), "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const allowed =
          specifier === "zod" ||
          specifier.startsWith("./") ||
          specifier === "../errors.js" ||
          specifier.startsWith("../playbook/");
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("exports the reducer and the checkpoint contract from the engine barrel", async () => {
    const engine = await import("./index.js");
    expect(typeof engine.next).toBe("function");
    expect(typeof engine.createRunRecord).toBe("function");
    expect(typeof engine.hydrateRunRecord).toBe("function");
    expect(typeof engine.readySteps).toBe("function");
  });
});
