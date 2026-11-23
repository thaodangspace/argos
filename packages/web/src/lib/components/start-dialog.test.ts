// @vitest-environment jsdom
/**
 * The typed start dialog (spec FR13): playbook discovery, per-type controls, required validation,
 * one idempotent submit, and inline server errors.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { PlaybookSummary, StartRunRequest } from "@thaodangspace/argos-core/rpc/contracts";

import { ArgosApiError, type ArgosApi } from "#lib/api";
import StartRunDialog from "./StartRunDialog.svelte";

const playbook: PlaybookSummary = {
  id: "release",
  file: "/repo/.argos/playbooks/release.yaml",
  hash: "h",
  stepCount: 2,
  inputs: [
    { name: "version", type: "string", required: true },
    { name: "count", type: "number", required: false },
    { name: "dry_run", type: "boolean", required: false, default: false },
    { name: "channel", type: "enum", required: false, values: ["stable", "beta"], default: "stable" },
  ],
};

function api(overrides: Partial<ArgosApi> = {}): ArgosApi {
  const base: ArgosApi = {
    listRuns: async () => [],
    getRun: async () => {
      throw new Error("unused");
    },
    startRun: async () => ({ runId: "new-run", taskId: "t1" }),
    cancelRun: async () => ({ runId: "r", status: "cancelled" }),
    retryStep: async () => ({ runId: "r", taskId: "t" }),
    forkRun: async () => ({ runId: "r", taskId: "t" }),
    decideGate: async () => ({ runId: "r", gateId: "g", decision: "approve", decidedAt: 1 }),
    listPlaybooks: async () => ({ cwd: "/repo", playbooks: [playbook], errors: [] }),
    listSchedules: async () => [],
    info: async () => {
      throw new Error("no info");
    },
  };
  return { ...base, ...overrides };
}

async function openDialog(overrides: Partial<ArgosApi> = {}) {
  const calls: StartRunRequest[] = [];
  const startRun = vi.fn(async (request: StartRunRequest) => {
    calls.push(request);
    return { runId: "new-run", taskId: "t1" };
  });
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(StartRunDialog, {
    props: {
      open: true,
      onClose,
      onStarted,
      api: api({ startRun, ...overrides }),
      initial: { cwd: "/repo" },
    },
  });
  // A prefilled cwd auto-loads its playbooks; no Load click is needed.
  await waitFor(() => expect(screen.getByRole("option", { name: /release/ })).toBeTruthy());
  return { startRun, calls, onStarted, onClose };
}

describe("StartRunDialog", () => {
  it("loads on demand when the dialog opens without a directory", async () => {
    window.localStorage.clear();
    const startRun = vi.fn(async () => ({ runId: "new-run", taskId: "t1" }));
    render(StartRunDialog, {
      props: { open: true, onClose: vi.fn(), onStarted: vi.fn(), api: api({ startRun }) },
    });
    const cwd = screen.getByLabelText(/Working directory/) as HTMLInputElement;
    expect(screen.queryByRole("option", { name: /release/ })).toBeNull();
    await fireEvent.input(cwd, { target: { value: "/repo" } });
    await fireEvent.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /release/ })).toBeTruthy());
  });

  it("loads playbooks for the cwd and renders a control per input type", async () => {
    await openDialog();
    expect((screen.getByLabelText(/Working directory/) as HTMLInputElement).value).toBe("/repo");
    expect(screen.getByLabelText(/version/)).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByLabelText(/count/)).toBeTruthy();
    expect(screen.getByText("stable")).toBeTruthy();
  });

  it("submits the coerced request once the required field is filled", async () => {
    const { startRun, onStarted } = await openDialog();
    await fireEvent.input(screen.getByLabelText(/version/), { target: { value: "1.2.3" } });
    await fireEvent.input(screen.getByLabelText(/count/), { target: { value: "42" } });
    await fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    const request = startRun.mock.calls[0]?.[0] as {
      playbookId: string;
      cwd: string;
      inputs: Record<string, unknown>;
      clientRequestId?: string;
    };
    expect(request.playbookId).toBe("release");
    expect(request.cwd).toBe("/repo");
    expect(request.inputs).toMatchObject({ version: "1.2.3", count: 42, dry_run: false, channel: "stable" });
    expect(request.clientRequestId).toEqual(expect.any(String));
    expect(onStarted).toHaveBeenCalledWith("new-run");
  });

  it("blocks submit when a required input is empty", async () => {
    const { startRun } = await openDialog();
    await fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(screen.getByText(/version is required/)).toBeTruthy());
    expect(startRun).not.toHaveBeenCalled();
  });

  it("shows a stable server error inline and keeps the form values", async () => {
    const startRun = vi.fn(async () => {
      throw new ArgosApiError("playbook_invalid", "the playbook is broken", 422);
    });
    const { onStarted } = await openDialog({ startRun });
    await fireEvent.input(screen.getByLabelText(/version/), { target: { value: "9" } });
    await fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("playbook_invalid"));
    expect(screen.getByRole("alert").textContent).toContain("the playbook is broken");
    expect((screen.getByLabelText(/version/) as HTMLInputElement).value).toBe("9");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const { onClose } = await openDialog();
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps typed values when the parent re-renders with a new initial object", async () => {
    // The run page passes `initial={{…}}` inline, so every frame is a new identity. The dialog must
    // reset once per open, not once per render (spec FR13, and the effect loop this guards).
    const calls: StartRunRequest[] = [];
    const startRun = vi.fn(async (request: StartRunRequest) => {
      calls.push(request);
      return { runId: "new-run", taskId: "t1" };
    });
    const props = {
      open: true,
      onClose: vi.fn(),
      onStarted: vi.fn(),
      api: api({ startRun }),
      initial: { cwd: "/repo" },
    };
    const result = render(StartRunDialog, { props });
    const cwdInput = screen.getByLabelText(/Working directory/) as HTMLInputElement;
    await fireEvent.input(cwdInput, { target: { value: "/typed" } });
    await result.rerender({ ...props, initial: { cwd: "/repo" } });
    expect(cwdInput.value).toBe("/typed");
  });
});
