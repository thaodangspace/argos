// @vitest-environment jsdom
/**
 * The copy affordance (spec FR10): the button must write exactly the log text the view model built.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepSummarySchema } from "@thaodangspace/argos-core/rpc/contracts";
import { buildStepLog, logText } from "@thaodangspace/argos-core/view";

import CopyButton from "./CopyButton.svelte";

const writeText = vi.fn(async () => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CopyButton", () => {
  it("writes the provided text and confirms visually", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const text = "01:00:00  Dispatched (attempt 1)\n        Output plan:\n        line one";
    render(CopyButton, { props: { text, label: "Copy step log" } });

    await fireEvent.click(screen.getByRole("button", { name: "Copy step log" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    await waitFor(() => expect(screen.getByRole("button").textContent?.trim()).toBe("Copied"));
  });

  it("copies a script attempt's reason and stream tails in one text", async () => {
    const step = StepSummarySchema.parse({
      id: "ship",
      title: "Ship",
      kind: "script",
      status: "failed",
      attemptCount: 1,
      startedAt: 0,
      endedAt: 125,
    });
    const text = logText(
      buildStepLog({
        step,
        history: [],
        gates: [],
        attempts: [
          {
            n: 1,
            startedAt: 0,
            endedAt: 125,
            durationLabel: "125ms",
            outcome: "failed",
            errorCode: "step_failed",
            detail: "the script exited 1: Fetch failed: HTTP 503",
            exitCode: 1,
            streams: { stderr: "Fetch failed: HTTP 503" },
            usageLabel: null,
            running: false,
          },
        ],
        outputs: [],
      }),
    );
    // What the button writes is exactly what the view model built (FR9).
    expect(text).toContain(
      "Attempt 1 failed in 125ms (step_failed): the script exited 1: Fetch failed: HTTP 503",
    );
    expect(text.split("\n").slice(-2)).toEqual([
      expect.stringMatching(/^\d{2}:\d{2}:\d{2}  stderr:$/),
      "        Fetch failed: HTTP 503",
    ]);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(CopyButton, { props: { text, label: "Copy step log" } });
    await fireEvent.click(screen.getByRole("button", { name: "Copy step log" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  });

  it("survives a denied clipboard without reporting success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    render(CopyButton, { props: { text: "x", label: "Copy" } });
    await fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button").textContent?.trim()).toBe("Copy");
  });
});
