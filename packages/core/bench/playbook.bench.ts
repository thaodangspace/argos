/**
 * The playbook layer: discovery and `loadPlaybook` (parse → zod → resolve → expand → validate →
 * hash → deep-freeze).
 *
 * This pipeline runs once per `POST /runs` and, for a schedule, once per fire, so its cost is the
 * fixed price of starting anything. It also runs per `argos validate` and per `argos schedule add`,
 * where the whole repository is discovered first.
 *
 * The fixtures are generated into a temp repo rather than committed: a checked-in YAML would drift
 * from the schema and stop being representative the moment a key is added.
 *
 * Run: `npm run bench` (or `npx vitest bench packages/core/bench/playbook.bench.ts`).
 */

import { afterAll, describe, test } from "vitest";

import { discoverPlaybooks, loadPlaybook, playbookHash } from "../src/playbook/index.js";
import { makeBenchRepo, playbookYaml } from "./support.js";

const TINY_FILES = 48;

const repo = makeBenchRepo();
repo.write("bench-10", playbookYaml("bench-10", 10));
repo.write("bench-40", playbookYaml("bench-40", 40));
for (let index = 0; index < TINY_FILES; index += 1) {
  const id = `tiny-${String(index).padStart(2, "0")}`;
  repo.write(id, playbookYaml(id, 1));
}

// Loaded once at module scope: a bench body that re-ran discovery would measure fs, not the loader.
const loaded10 = loadPlaybook(repo.dir, "bench-10");
const loaded40 = loadPlaybook(repo.dir, "bench-40");

afterAll(() => {
  repo.cleanup();
});

describe("playbook", () => {
  test("loadPlaybook", async ({ bench }) => {
    await bench.compare(
      bench("10-step playbook (parse, validate, hash, freeze)", () => {
        loadPlaybook(repo.dir, "bench-10");
      }),
      bench("40-step playbook (parse, validate, hash, freeze)", () => {
        loadPlaybook(repo.dir, "bench-40");
      }),
    );
  });

  test("discovery", async ({ bench }) => {
    await bench(`discoverPlaybooks over ${String(TINY_FILES + 2)} files`, () => {
      discoverPlaybooks(repo.dir);
    }).run();
  });

  test("hashing", async ({ bench }) => {
    await bench.compare(
      bench("playbookHash of a 10-step IR", () => {
        playbookHash(loaded10);
      }),
      bench("playbookHash of a 40-step IR", () => {
        playbookHash(loaded40);
      }),
    );
  });
});
