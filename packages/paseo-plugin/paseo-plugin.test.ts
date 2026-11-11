import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_ID, REQUIRED_PASEO_VERSION } from "./src/index.js";

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  requirements: { paseo: string };
}

const manifestPath = fileURLToPath(new URL("./paseo-plugin.json", import.meta.url));

function readManifest(): PluginManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
}

describe("paseo-plugin.json", () => {
  it("is valid JSON with the required keys", () => {
    const manifest = readManifest();
    expect(manifest.id).toBe("argos");
    expect(manifest.name).toBe("Argos");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.requirements.paseo).toBe(">=0.15.3");
  });

  it("matches the plugin constants", () => {
    const manifest = readManifest();
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.requirements.paseo).toBe(REQUIRED_PASEO_VERSION);
  });
});
