/**
 * Native render test: the panel must render on Paseo mobile (iOS/Android), not only on desktop.
 *
 * Desktop renders plugins through react-native-web, which forgives DOM elements and CSS; native
 * React Native does not, so a DOM-built panel showed on desktop and silently vanished on mobile.
 * This test renders the real client components with `react-native` replaced by bare host
 * components (`"View"`, `"Text"`, …, like React Native's own Jest preset) and walks the tree for the
 * rules native enforces:
 *
 * - only React Native host components (no `div`/`span`/`button`/`input`);
 * - every string inside a `Text`, and no `View` inside a `Text`;
 * - native style values: numbers for sizes, no CSS shorthands, no web-only keys, one font family;
 * - every outermost `Text` sets a color (native `Text` does not inherit it from a `View`, so a
 *   missing color is black-on-dark in the dark theme).
 */

import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { RunDetail, StepDetailSummary } from "@thaodangspace/argos-core/rpc/contracts";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Platform: {
    OS: "ios",
    select: (specifics: Record<string, unknown>) =>
      "ios" in specifics ? specifics["ios"] : "native" in specifics ? specifics["native"] : specifics["default"],
  },
}));

vi.mock("@getpaseo/plugin/client/ui", () => ({
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  copyText: async () => undefined,
  // The SDK row renders its own native chrome; only our `trailing` slot is under test.
  SidebarRow: ({ trailing }: { trailing?: ReactNode }) => createElement("SidebarRow", null, trailing),
}));

/** The runs `argos.runs.list` returns to the contribution test; other RPCs are not called. */
const rpc = vi.hoisted(() => ({
  calls: new Map<string, (input: unknown) => Promise<unknown>>(),
  runs: [] as unknown[],
}));

vi.mock("@getpaseo/plugin/client", () => ({
  // Stable functions per contract, like the host's hook (the panel effect depends on identity).
  useRpc: (contract: { readonly name: string }) => {
    let call = rpc.calls.get(contract.name);
    if (call === undefined) {
      call = async () => ({ ok: true, data: rpc.runs });
      rpc.calls.set(contract.name, call);
    }
    return call;
  },
}));

const { ArgosScreenView } = await import("../client/screen");
const { createPanel } = await import("../shared/panel");
const { default: contribute } = await import("../index.client");
const { fakeRpc, makeGate, makeRun, makeStep } = await import("./support.js");

// React only routes `act` warnings when this flag is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THEME: PluginTheme = {
  colors: {
    surface0: "#101010",
    surface1: "#181818",
    surface2: "#202020",
    border: "#333333",
    foreground: "#eeeeee",
    foregroundMuted: "#999999",
    accent: "#4c8dff",
    accentForeground: "#ffffff",
    statusSuccess: "#3fb950",
    statusWarning: "#d29922",
    statusDanger: "#f85149",
  },
};

// ------------------------------------------------------------------ native rules

const HOST_TYPES = new Set(["View", "Text", "Pressable", "ScrollView", "TextInput", "SidebarRow"]);
const TEXT_HOSTS = new Set(["Text", "TextInput"]);

const NUMBER_KEYS = new Set([
  "flex",
  "flexGrow",
  "flexShrink",
  "gap",
  "rowGap",
  "columnGap",
  "borderWidth",
  "borderTopWidth",
  "borderRadius",
  "opacity",
  "fontSize",
  "lineHeight",
]);
const DIMENSION_KEYS = new Set([
  "flexBasis",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "marginHorizontal",
  "marginVertical",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingHorizontal",
  "paddingVertical",
]);
const ENUM_KEYS: Readonly<Record<string, readonly string[]>> = {
  alignItems: ["flex-start", "flex-end", "center", "stretch", "baseline"],
  alignSelf: ["auto", "flex-start", "flex-end", "center", "stretch", "baseline"],
  justifyContent: ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"],
  flexDirection: ["row", "column", "row-reverse", "column-reverse"],
  flexWrap: ["wrap", "nowrap", "wrap-reverse"],
  overflow: ["visible", "hidden", "scroll"],
  display: ["flex", "none"],
  fontWeight: ["normal", "bold", "400", "500", "600", "700"],
  textAlign: ["auto", "left", "right", "center"],
  textAlignVertical: ["auto", "top", "bottom", "center"],
};
const COLOR_KEYS = new Set(["backgroundColor", "borderColor", "borderTopColor", "color"]);
const TEXT_ONLY_KEYS = new Set([
  "color",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "lineHeight",
  "textAlign",
  "textAlignVertical",
]);

type Style = Record<string, unknown>;

function flattenStyle(style: unknown, pressed: boolean): Style {
  if (typeof style === "function") return flattenStyle(style({ pressed }), pressed);
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((entry) => flattenStyle(entry, pressed))) as Style;
  }
  if (style === null || style === undefined || style === false) return {};
  return { ...(style as Style) };
}

function styleViolations(type: string, where: string, style: Style): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    const at = `${where} style.${key}=${JSON.stringify(value)}`;
    if (TEXT_ONLY_KEYS.has(key) && !TEXT_HOSTS.has(type)) {
      problems.push(`${at}: text style on <${type}>`);
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value !== "number") problems.push(`${at}: native needs a number`);
    } else if (DIMENSION_KEYS.has(key)) {
      const ok =
        typeof value === "number" ||
        value === "auto" ||
        (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value));
      if (!ok) problems.push(`${at}: native needs a number, "auto", or a percentage`);
    } else if (key in ENUM_KEYS) {
      if (!ENUM_KEYS[key]?.includes(String(value))) problems.push(`${at}: not a native value`);
    } else if (COLOR_KEYS.has(key)) {
      if (typeof value !== "string") problems.push(`${at}: color must be a string`);
    } else if (key === "fontFamily") {
      if (typeof value !== "string" || value.includes(",")) {
        problems.push(`${at}: native takes one font family, not a CSS stack`);
      }
    } else {
      problems.push(`${at}: not a React Native style key`);
    }
  }
  return problems;
}

type Node = ReactTestRendererJSON;

function nativeViolations(
  node: Node | string,
  parent: Node | null,
  insideText: boolean,
  path: string,
): string[] {
  if (typeof node === "string") {
    if (parent?.type !== "Text") {
      return [`${path}: text ${JSON.stringify(node)} is not inside <Text>`];
    }
    return [];
  }

  const problems: string[] = [];
  const where = `${path}/${node.type}`;
  if (!HOST_TYPES.has(node.type)) {
    problems.push(`${where}: <${node.type}> is not a React Native component`);
  }
  if (insideText && node.type !== "Text") {
    problems.push(`${where}: <${node.type}> inside <Text>`);
  }

  for (const prop of ["style", "contentContainerStyle"] as const) {
    if (node.props[prop] === undefined) continue;
    for (const pressed of node.type === "Pressable" ? [false, true] : [false]) {
      problems.push(...styleViolations(node.type, `${where}.${prop}`, flattenStyle(node.props[prop], pressed)));
    }
  }

  if (node.type === "Text" && !insideText) {
    const color = flattenStyle(node.props["style"], false)["color"];
    if (typeof color !== "string") problems.push(`${where}: outermost <Text> has no color`);
  }
  if (node.type === "TextInput" && typeof flattenStyle(node.props["style"], false)["color"] !== "string") {
    problems.push(`${where}: <TextInput> has no color`);
  }

  const childInsideText = insideText || node.type === "Text";
  for (const [index, child] of (node.children ?? []).entries()) {
    problems.push(...nativeViolations(child, node, childInsideText, `${where}[${index}]`));
  }
  return problems;
}

function treeOf(renderer: ReactTestRenderer): Node[] {
  const json = renderer.toJSON();
  if (json === null) return [];
  return Array.isArray(json) ? json : [json];
}

function expectNative(renderer: ReactTestRenderer): void {
  const problems = treeOf(renderer).flatMap((node) => nativeViolations(node, null, false, ""));
  expect(problems).toEqual([]);
}

/** Every string in the tree, joined (to assert that content actually rendered). */
function textOf(renderer: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: Node | string): void => {
    if (typeof node === "string") parts.push(node);
    else for (const child of node.children ?? []) walk(child);
  };
  for (const node of treeOf(renderer)) walk(node);
  return parts.join("");
}

/** Press the first Pressable whose text contains `label`. */
async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  const target = renderer.root.findAll(
    (instance) =>
      isHost(instance, "Pressable") &&
      instance.findAll((child) => isHost(child, "Text") && textOfInstance(child).includes(label)).length > 0,
  )[0];
  if (target === undefined) throw new Error(`no pressable labelled "${label}"`);
  await act(async () => {
    (target.props["onPress"] as () => void)();
  });
}

type Instance = ReactTestRenderer["root"];

/** The mocked host components are plain strings, which React's `ElementType` does not name. */
function isHost(instance: Instance, type: string): boolean {
  return (instance.type as unknown) === type;
}

function textOfInstance(instance: Instance): string {
  return instance.children
    .map((child) => (typeof child === "string" ? child : textOfInstance(child)))
    .join("");
}

// ------------------------------------------------------------------ fixtures

function detailStep(overrides: Partial<StepDetailSummary> & { id: string }): StepDetailSummary {
  return { title: overrides.id, kind: "script", status: "completed", attemptCount: 1, attempts: [], ...overrides };
}

const DETAIL_STEPS: StepDetailSummary[] = [
  detailStep({
    id: "pick",
    title: "Pick spec",
    kind: "agent",
    startedAt: 1_500,
    endedAt: 2_500,
    outcome: "success",
    attempts: [
      {
        n: 1,
        startedAt: 1_500,
        endedAt: 2_500,
        outcome: "completed",
        target: "claude/opus",
        usage: { inputTokens: 120, outputTokens: 3_000, totalCostUsd: 0.42 },
      },
    ],
    outputs: { stdout: "specs/VP-7.md\n" },
  }),
  detailStep({
    id: "ship",
    title: "Ship",
    status: "failed",
    attemptCount: 2,
    startedAt: 2_500,
    endedAt: 4_500,
    errorCode: "step_timeout",
    attempts: [{ n: 1, startedAt: 2_500, endedAt: 4_500, outcome: "timeout" }],
  }),
  detailStep({ id: "review", title: "Review", kind: "gate", status: "waiting", attemptCount: 0 }),
  detailStep({ id: "later", title: "Later", status: "pending", attemptCount: 0 }),
];

function detailRun(): RunDetail {
  const run = makeRun({
    id: "run-1",
    playbookId: "va-spec-impl",
    status: "failed",
    inputs: { ticket: "VP-7" },
    createdAt: 1_000,
    updatedAt: 4_500,
    steps: DETAIL_STEPS,
    gates: [makeGate({ gateId: "gate:1", runId: "run-1" })],
    after: [{ id: "notify", title: "Notify", trigger: "auto", status: "completed" }],
  });
  return {
    ...run,
    steps: DETAIL_STEPS,
    history: [
      { at: 1_000, seq: 0, type: "run_started", stepId: null, attempt: null, detail: "va-spec-impl" },
      { at: 1_500, seq: 1, type: "dispatch", stepId: "pick", attempt: 1, detail: null },
      { at: 2_000, seq: 2, type: "settle", stepId: null, attempt: null, detail: "1 step(s) settled" },
    ],
  };
}

/** Three workflows: a busy one (fold + "show older"), a single run, and one waiting on a gate. */
function listRuns() {
  const busy = Array.from({ length: 7 }, (_, index) =>
    makeRun({
      id: `busy-${index}`,
      playbookId: "hourly-sync",
      status: index === 0 ? "failed" : "completed",
      createdAt: 10_000 - index * 100,
      updatedAt: 10_000 - index * 100,
      steps: [
        makeStep({ id: "fetch", status: "completed", attemptCount: 1 }),
        makeStep({ id: "push", status: index === 0 ? "failed" : "completed", attemptCount: 1 }),
      ],
    }),
  );
  return [
    ...busy,
    makeRun({ id: "solo-1", playbookId: "docs", status: "completed", createdAt: 5_000, updatedAt: 6_000 }),
    makeRun({
      id: "gated-1",
      playbookId: "release",
      status: "waiting",
      steps: [makeStep({ id: "review", kind: "gate", status: "waiting" })],
      gates: [makeGate({ gateId: "gate:1", runId: "gated-1" })],
    }),
  ];
}

// ------------------------------------------------------------------ tests

const mounted: ReactTestRenderer[] = [];

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(element);
  });
  if (renderer === undefined) throw new Error("render failed");
  mounted.push(renderer);
  return renderer;
}

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  rpc.calls.clear();
  rpc.runs = [];
});

describe("panel renders with React Native primitives only", () => {
  it("the empty run list", async () => {
    const panel = createPanel({ client: fakeRpc({ runs: [] }) });
    await panel.load();
    const renderer = await render(<ArgosScreenView theme={THEME} panel={panel} />);
    expectNative(renderer);
    expect(textOf(renderer)).toContain("No Argos runs yet");
  });

  it("the grouped run list, an unfolded group, and its older runs", async () => {
    const panel = createPanel({ client: fakeRpc({ runs: listRuns() }) });
    await panel.load();
    const renderer = await render(<ArgosScreenView theme={THEME} panel={panel} />);
    expectNative(renderer);
    expect(textOf(renderer)).toContain("hourly-sync");
    expect(textOf(renderer)).toContain("release");

    await press(renderer, "older");
    expectNative(renderer);
  });

  it("the start-run form", async () => {
    const panel = createPanel({ client: fakeRpc({ runs: [] }) });
    await panel.load();
    const renderer = await render(<ArgosScreenView theme={THEME} panel={panel} />);
    await press(renderer, "New run");
    expectNative(renderer);
    expect(renderer.root.findAll((node) => isHost(node, "TextInput"))).toHaveLength(3);

    // An invalid submit shows the form error, still as native text.
    await press(renderer, "Start");
    expectNative(renderer);
  });

  it("the error banner", async () => {
    const client = fakeRpc({ runs: [] });
    client.listRuns.mockRejectedValue(new Error("connection refused"));
    const panel = createPanel({ client });
    await panel.load();
    const renderer = await render(<ArgosScreenView theme={THEME} panel={panel} />);
    expectNative(renderer);
    expect(textOf(renderer)).toContain("connection refused");
  });

  it("a run page: header, meta, pending gate, steps, step log, run log, after tasks", async () => {
    const detail = detailRun();
    const { history: _history, ...summary } = detail;
    const panel = createPanel({ client: fakeRpc({ runs: [summary], detail }) });
    await panel.load();
    await panel.selectRun("run-1");
    const renderer = await render(<ArgosScreenView theme={THEME} panel={panel} />);
    expectNative(renderer);
    const text = textOf(renderer);
    expect(text).toContain("va-spec-impl");
    expect(text).toContain("Ship it?");
    expect(text).toContain("step_timeout");
    expect(text).toContain("Notify");

    await press(renderer, "Pick spec");
    expectNative(renderer);
    expect(textOf(renderer)).toContain("Attempt 1 started on claude/opus");

    await press(renderer, "Run log");
    expectNative(renderer);
    expect(textOf(renderer)).toContain("Run started: va-spec-impl");

    await press(renderer, "Remove");
    expectNative(renderer);
    expect(textOf(renderer)).toContain("Confirm remove");
  });

  it("the sidebar row and the screen through the client contribution", async () => {
    rpc.runs = listRuns();
    const screens: { Component: (props: PluginScreenProps) => ReactNode }[] = [];
    const items: { Component: (props: PluginSidebarItemProps) => ReactNode }[] = [];
    const context = {
      addScreen: (contribution: (typeof screens)[number]) => {
        screens.push(contribution);
        return () => undefined;
      },
      addSidebarHeaderItem: (contribution: (typeof items)[number]) => {
        items.push(contribution);
        return () => undefined;
      },
    } as unknown as PluginClientContext;
    const cleanup = contribute(context);

    const Sidebar = items[0]?.Component;
    const Screen = screens[0]?.Component;
    if (Sidebar === undefined || Screen === undefined) throw new Error("contributions missing");
    const layout = { compact: true, platform: "ios" as const };
    const host = { id: "local", label: "Local" };

    const sidebar = await render(
      <Sidebar
        theme={THEME}
        host={host}
        layout={layout}
        currentScreen={null}
        openScreen={() => undefined}
        openPopover={() => undefined}
      />,
    );
    const screen = await render(<Screen theme={THEME} host={host} layout={layout} params={{}} />);

    await vi.waitFor(() => {
      expect(textOf(sidebar)).toContain("waiting");
    });
    expectNative(sidebar);
    expectNative(screen);
    expect(textOf(screen)).toContain("hourly-sync");

    for (const renderer of mounted.splice(0)) {
      await act(async () => {
        renderer.unmount();
      });
    }
    cleanup();
  });
});
