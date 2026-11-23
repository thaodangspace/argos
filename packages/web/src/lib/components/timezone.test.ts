// @vitest-environment jsdom
/**
 * The timezone picker: local by default, `UTC` only when chosen.
 *
 * The picker is presentation only — it reports the chosen id and the store persists it — so the test
 * pins the option list and the two calls a reader can make: pick a zone, go back to Local.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import TimeZoneSelect from "./TimeZoneSelect.svelte";

afterEach(cleanup);

const ZONES = ["UTC", "America/New_York", "Europe/Berlin"] as const;

describe("TimeZoneSelect", () => {
  it("offers Local first, then UTC and every known zone", () => {
    render(TimeZoneSelect, {
      props: {
        system: "Asia/Saigon",
        value: undefined,
        zones: ZONES,
        onSelect: () => {},
      },
    });
    const select = screen.getByLabelText("Time zone") as HTMLSelectElement;
    // No stored choice: the picker sits on "Local", which names the browser's own zone.
    expect(select.value).toBe("");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Local · Asia/Saigon",
      "UTC",
      "America/New_York",
      "Europe/Berlin",
    ]);
    expect(select.getAttribute("title")).toBe("Timestamps are shown in this zone");
  });

  it("shows an explicit choice and reports the two ways back", async () => {
    const onSelect = vi.fn<(zone: string) => void>();
    render(TimeZoneSelect, {
      props: { system: "Asia/Saigon", value: "UTC", zones: ZONES, onSelect },
    });
    const select = screen.getByLabelText("Time zone") as HTMLSelectElement;
    expect(select.value).toBe("UTC");

    await fireEvent.change(select, { target: { value: "Europe/Berlin" } });
    expect(onSelect).toHaveBeenLastCalledWith("Europe/Berlin");

    // The empty value is the sentinel for "follow the browser".
    await fireEvent.change(select, { target: { value: "" } });
    expect(onSelect).toHaveBeenLastCalledWith("");
  });
});
