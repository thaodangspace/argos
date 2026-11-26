// @vitest-environment jsdom
/**
 * Gate decisions (spec FR12): one call per action, a required comment blocks, in-flight disables,
 * and a decided gate renders its record instead of buttons.
 */

import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { GateSummary } from "@thaodangspace/argos-core/rpc/contracts";
import { gateView, type GateView } from "@thaodangspace/argos-core/view";

import GateCard from "./GateCard.svelte";

const pending: GateView = gateView({
  runId: "01J0000000000000000000000A",
  gateId: "ship:1",
  stepId: "ship",
  kind: "step",
  question: "Ship version 1.2.3?",
  choices: {
    approve: { label: "Approve", comment: "optional", color: "success" },
    reject: { label: "Reject", comment: "required", color: "danger" },
  },
  status: "pending",
});

describe("GateCard", () => {
  it("renders the question, the choices and the required marker", () => {
    render(GateCard, { props: { gate: pending, onDecide: vi.fn() } });
    expect(screen.getByText("Ship version 1.2.3?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("blocks a required-comment choice until a comment is typed", async () => {
    const onDecide = vi.fn(async () => undefined);
    render(GateCard, { props: { gate: pending, onDecide } });
    await fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("needs a comment");

    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "not yet" } });
    await fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("reject", "not yet");
  });

  it("submits an optional-comment choice without one", async () => {
    const onDecide = vi.fn(async () => undefined);
    render(GateCard, { props: { gate: pending, onDecide } });
    await fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("approve", undefined);
  });

  it("disables every button while a decision is in flight", () => {
    render(GateCard, { props: { gate: { ...pending, deciding: true }, onDecide: vi.fn() } });
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });

  it("renders the decision record for a decided gate", () => {
    render(GateCard, {
      props: {
        gate: { ...pending, status: "decided", decision: "approve" },
        onDecide: vi.fn(),
      },
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("approve")).toBeTruthy();
  });

  it("qualifies the question id and its label with the run (inbox FR7)", () => {
    const summary = (runId: string, question: string): GateSummary => ({
      runId,
      gateId: "fix:1",
      stepId: "fix",
      kind: "step",
      question,
      choices: { approve: { label: "Approve", comment: "optional" } },
      status: "pending",
    });
    const runA = gateView(summary("01J0000000000000000000000A", "Fix run A?"));
    const runB = gateView(summary("01J0000000000000000000000B", "Fix run B?"));
    render(GateCard, { props: { gate: runA, onDecide: vi.fn() } });
    render(GateCard, { props: { gate: runB, onDecide: vi.fn() } });

    const articles = [...document.querySelectorAll("article.gate")];
    expect(articles).toHaveLength(2);
    const labelledBy = articles.map((article) => article.getAttribute("aria-labelledby"));
    expect(labelledBy).toEqual([
      "gate-01J0000000000000000000000A-fix:1",
      "gate-01J0000000000000000000000B-fix:1",
    ]);
    expect(new Set(labelledBy).size).toBe(2);
    expect(articles.map((article) => article.querySelector("p.question")?.id)).toEqual(labelledBy);
    // A bare `gate-<gateId>` id would collide on an inbox that holds both runs.
    expect(document.querySelectorAll("#gate-fix\\:1")).toHaveLength(0);
  });
});
