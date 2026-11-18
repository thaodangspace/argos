/**
 * Routing helpers (spec FR1): the app lives under `UI_BASE`, so anchors and redirects always carry
 * that prefix — including when the current page is itself a deep link.
 */

import { describe, expect, it } from "vitest";

import { UI_BASE } from "./base.js";
import { href, runHref, stepHref } from "./paths.js";

describe("paths", () => {
  it("uses one base constant, never a relative BASE_URL", () => {
    expect(UI_BASE).toBe("/ui");
    expect(href("/")).toBe("/ui/");
    expect(href("runs")).toBe("/ui/runs");
    expect(href("/runs/x")).toBe("/ui/runs/x");
  });

  it("builds run and step links that stay absolute on a deep page", () => {
    expect(runHref("01J A")).toBe("/ui/runs/01J%20A");
    expect(stepHref("01J", "step id")).toBe("/ui/runs/01J?step=step%20id");
    // A relative link would resolve to /ui/runs/runs/<id> from /ui/runs/<old>.
    expect(runHref("x").startsWith("/")).toBe(true);
  });
});
