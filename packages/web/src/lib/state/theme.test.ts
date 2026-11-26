// @vitest-environment jsdom

/**
 * The theme write (spec FR7): the colour mode is the `dark` class on `<html>`, never a `data-theme`
 * attribute — `data-theme="vintage"` selects the Skeleton theme and is only ever written in
 * `app.html`. `preferredTheme` is already covered by `../state.test.ts`, so it is not repeated here.
 */

import { afterEach, describe, expect, it } from "vitest";

import { applyTheme } from "./theme.svelte.js";

const root = (): HTMLElement => document.documentElement;

afterEach(() => {
  root().classList.remove("dark");
  root().removeAttribute("data-theme");
});

describe("applyTheme", () => {
  it("removes the class in light mode and adds it in dark mode", () => {
    applyTheme("dark");
    expect(root().classList.contains("dark")).toBe(true);

    applyTheme("light");
    expect(root().classList.contains("dark")).toBe(false);
  });

  it("never writes data-theme, which belongs to app.html alone", () => {
    applyTheme("dark");
    expect(root().hasAttribute("data-theme")).toBe(false);

    applyTheme("light");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("writes onto the element it is given, so a test needs no document", () => {
    const element = document.createElement("div");
    applyTheme("dark", element);
    expect(element.classList.contains("dark")).toBe(true);
    applyTheme("light", element);
    expect(element.classList.contains("dark")).toBe(false);
  });
});
