/**
 * Manifest test (FR28): `paseo-plugin.json` is the contract the Paseo loader reads, so it is
 * validated against a schema rather than poked field by field.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PLUGIN_ID, REQUIRED_PASEO_VERSION } from "../shared/identity";
import contribute from "../index.server.js";

/** The manifest fields the loader reads. `version` is ours (Paseo ignores it). */
const ManifestSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  description: z.string().min(1).optional(),
  media: z.array(z.string()).optional(),
  requirements: z.strictObject({ paseo: z.string().min(1) }),
});

const manifestPath = fileURLToPath(new URL("../paseo-plugin.json", import.meta.url));

function readManifest(): unknown {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
}

/** `">=0.15.3"` → `[0, 15, 3]`; only the `>=` form is allowed here. */
function parseMinimum(range: string): number[] {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (match === null) throw new Error(`unsupported requirement range: ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("paseo-plugin.json", () => {
  it("parses against the manifest schema", () => {
    const manifest = ManifestSchema.parse(readManifest());
    expect(manifest.id).toBe("argos");
    expect(manifest.name).toBe("Argos");
    expect(manifest.requirements.paseo).toBe(">=0.15.3");
  });

  it("requires at least Paseo 0.15.3 (the SDK version the plugin was written against)", () => {
    const manifest = ManifestSchema.parse(readManifest());
    expect(compare(parseMinimum(manifest.requirements.paseo), [0, 15, 3])).toBeGreaterThanOrEqual(0);
  });

  it("matches the plugin constants", () => {
    const manifest = ManifestSchema.parse(readManifest());
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.requirements.paseo).toBe(REQUIRED_PASEO_VERSION);
  });

  it("ships a server entry with a default contribution function", () => {
    expect(typeof contribute).toBe("function");
    expect(contribute.length).toBe(1);
  });
});
