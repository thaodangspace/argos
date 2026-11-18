// @vitest-environment jsdom
/**
 * The copy affordance (spec FR10): the button must write exactly the log text the view model built.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

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
