/**
 * FR19: the Herdr app's adoption labels come from the environment, and an install without the app
 * must be able to turn them off.
 *
 * Pure over `process.env`, so this pins the three names and their defaults without starting a
 * server or an `hc` core: `ARGOS_HERDR=0` means no labels, `ARGOS_HERDR_SPACE` names the space
 * (default `argos`), and `ARGOS_HERDR_TAB` pins a tab (default: absent, so the adapter uses the run
 * id and one run's steps share a tab).
 */

import { afterEach, describe, expect, it } from "vitest";

import { herdrLabels } from "../src/commands/serve.js";
import { withEnv } from "./support/cli.js";

const NAMES = ["ARGOS_HERDR", "ARGOS_HERDR_SPACE", "ARGOS_HERDR_TAB"] as const;

const restores: Array<() => void> = [];
function env(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  restores.push(withEnv(values as Record<string, string>));
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("herdrLabels (FR19)", () => {
  it("defaults to the argos space and no pinned tab", () => {
    expect(herdrLabels()).toEqual({ space: "argos" });
  });

  it("reads ARGOS_HERDR_SPACE and ARGOS_HERDR_TAB", () => {
    env({ ARGOS_HERDR_SPACE: "steps", ARGOS_HERDR_TAB: "nightly" });
    expect(herdrLabels()).toEqual({ space: "steps", tab: "nightly" });
  });

  it("is off with ARGOS_HERDR=0", () => {
    env({ ARGOS_HERDR: "0" });
    expect(herdrLabels()).toBeUndefined();
  });

  it("ignores blank values", () => {
    env({ ARGOS_HERDR: "1", ARGOS_HERDR_SPACE: "  ", ARGOS_HERDR_TAB: " " });
    expect(herdrLabels()).toEqual({ space: "argos" });
  });
});
