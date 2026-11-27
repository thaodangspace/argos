// @vitest-environment jsdom
/**
 * The editor screen's markup (editor FR20–FR25): the rail, the loaded text, the debounced validate,
 * the issues panel, the save, the conflict panel, and the read-only rule.
 *
 * The fake API is the `start-dialog.test.ts` pattern: a full `ArgosApi` with the one method under
 * test overridden, so the component never touches `fetch`.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PlaybookFileResponse,
  PlaybookIssue,
  PlaybookSaveResponse,
  PlaybookSummary,
  PlaybookVerdict,
} from "@thaodangspace/argos-core/rpc/contracts";

import { ArgosApiError, type PlaybookApi } from "#lib/api";
import PlaybookEditor from "./PlaybookEditor.svelte";
import PlaybookRail from "./PlaybookRail.svelte";

const CWD = "/repo";
const FILE = `${CWD}/.argos/playbooks/release.yaml`;
const YAML = "id: release\nsteps:\n  - id: build\n    prompt: hi\n";
const EDITED = "id: release\nsteps:\n  - id: build\n    prompt: hello\n";
const SHA = "a".repeat(64);

function verdict(overrides: Partial<PlaybookVerdict> = {}): PlaybookVerdict {
  return { playbookId: "release", valid: true, errors: [], warnings: [], hash: "h", ...overrides };
}

function fileResponse(overrides: Partial<PlaybookFileResponse> = {}): PlaybookFileResponse {
  return { ...verdict(), cwd: CWD, file: FILE, yaml: YAML, sha256: SHA, ...overrides };
}

function saved(): PlaybookSaveResponse {
  return { ...verdict(), file: FILE, sha256: "b".repeat(64), written: true, mode: 0o644 };
}

function summary(id: string, stepCount = 2): PlaybookSummary {
  return { id, file: `${CWD}/.argos/playbooks/${id}.yaml`, hash: `h-${id}`, inputs: [], stepCount };
}

function api(overrides: Partial<PlaybookApi> = {}): PlaybookApi {
  const base: PlaybookApi = {
    listPlaybooks: async () => ({ cwd: CWD, playbooks: [], errors: [] }),
    getPlaybookFile: async () => fileResponse(),
    validatePlaybook: async () => verdict(),
    savePlaybook: async () => saved(),
  };
  return { ...base, ...overrides };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function saveButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Save" }) as HTMLButtonElement | null;
}

async function openEditor(overrides: Partial<PlaybookApi> = {}, path = FILE) {
  render(PlaybookEditor, { props: { cwd: CWD, file: path, api: api(overrides) } });
  await waitFor(() => expect(textarea().value).toBe(YAML));
}

/** Type, then wait for the 400 ms debounce to issue its one validate call. */
async function edit(validatePlaybook: unknown, text = EDITED): Promise<void> {
  await fireEvent.input(textarea(), { target: { value: text } });
  await waitFor(() => expect(validatePlaybook).toHaveBeenCalledTimes(1));
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("PlaybookRail", () => {
  it("renders one row per file, a broken file included", () => {
    const onSelect = vi.fn();
    render(PlaybookRail, {
      props: {
        cwd: CWD,
        playbooks: [summary("release"), summary("deploy")],
        errors: [
          { file: `${CWD}/.argos/playbooks/broken.yaml`, code: "playbook_invalid", message: "bad" },
        ],
        selectedFile: null,
        onSelect,
      },
    });
    const nav = screen.getByRole("navigation", { name: "Playbooks" });
    expect(within(nav).getAllByRole("button")).toHaveLength(3);

    fireEvent.click(within(nav).getByRole("button", { name: /broken/ }));
    expect(onSelect).toHaveBeenCalledWith(`${CWD}/.argos/playbooks/broken.yaml`);
  });

  it("marks the selected row and says so when the directory has no playbook", () => {
    render(PlaybookRail, {
      props: {
        cwd: CWD,
        playbooks: [summary("release")],
        errors: [],
        selectedFile: `${CWD}/.argos/playbooks/release.yaml`,
        onSelect: vi.fn(),
      },
    });
    expect(
      screen.getByRole("button", { name: /release/ }).getAttribute("aria-current"),
    ).toBe("true");

    cleanup();
    render(PlaybookRail, {
      props: { cwd: CWD, playbooks: [], errors: [], selectedFile: null, onSelect: vi.fn() },
    });
    expect(screen.getByText(/No playbook found here/)).toBeTruthy();
  });
});

describe("PlaybookEditor", () => {
  it("renders the loaded text and its verdict", async () => {
    await openEditor();
    expect(textarea().value).toBe(YAML);
    expect(screen.getByText("valid")).toBeTruthy();
    expect(saveButton()?.disabled).toBe(true);
  });

  it("validates once after the 400 ms debounce", async () => {
    const validatePlaybook = vi.fn(async () => verdict());
    render(PlaybookEditor, { props: { cwd: CWD, file: FILE, api: api({ validatePlaybook }) } });
    await waitFor(() => expect(textarea().value).toBe(YAML));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await fireEvent.input(textarea(), { target: { value: EDITED } });
    expect(validatePlaybook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(399);
    expect(validatePlaybook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(validatePlaybook).toHaveBeenCalledTimes(1);
    expect(validatePlaybook).toHaveBeenCalledWith({ cwd: CWD, file: FILE, yaml: EDITED });

    // A second burst is a second call, not one per keystroke.
    await fireEvent.input(textarea(), { target: { value: `${EDITED}\n# more` } });
    await vi.advanceTimersByTimeAsync(400);
    expect(validatePlaybook).toHaveBeenCalledTimes(2);
  });

  it("disables Save and lists the issues for an invalid verdict", async () => {
    const issue: PlaybookIssue = {
      path: "steps.0.prompt",
      stepId: "build",
      message: 'unrecognized key "promt"',
    };
    const validatePlaybook = vi.fn(async () =>
      verdict({
        valid: false,
        errors: [
          {
            file: FILE,
            code: "playbook_invalid",
            message: "the playbook is broken",
            issues: [issue],
          },
        ],
      }),
    );
    await openEditor({ validatePlaybook });
    await edit(validatePlaybook);

    await waitFor(() => expect(screen.getByText("invalid")).toBeTruthy());
    expect(saveButton()?.disabled).toBe(true);
    expect(screen.getByText(/unrecognized key/)).toBeTruthy();
    expect(screen.getByText(/steps\.0\.prompt/)).toBeTruthy();
    expect(screen.getByText("step build")).toBeTruthy();
  });

  it("saves with the loaded digest and clears dirty", async () => {
    const validatePlaybook = vi.fn(async () => verdict());
    const savePlaybook = vi.fn(async () => saved());
    await openEditor({ validatePlaybook, savePlaybook });
    await edit(validatePlaybook);
    await waitFor(() => expect(saveButton()?.disabled).toBe(false));

    await fireEvent.click(saveButton() as HTMLButtonElement);
    await waitFor(() => expect(savePlaybook).toHaveBeenCalledTimes(1));
    expect(savePlaybook).toHaveBeenCalledWith({ cwd: CWD, file: FILE, yaml: EDITED, baseSha256: SHA });
    // The written text is the new baseline, so Save goes back to disabled.
    await waitFor(() => expect(saveButton()?.disabled).toBe(true));
    expect(screen.queryByText("unsaved")).toBeNull();
  });

  it("turns a 409 into a conflict panel with exactly two actions", async () => {
    const validatePlaybook = vi.fn(async () => verdict());
    const savePlaybook = vi.fn(async () => {
      throw new ArgosApiError("playbook_conflict", "the playbook changed on disk", 409, {
        reason: "changed",
      });
    });
    await openEditor({ validatePlaybook, savePlaybook });
    await edit(validatePlaybook);
    await waitFor(() => expect(saveButton()?.disabled).toBe(false));
    await fireEvent.click(saveButton() as HTMLButtonElement);

    const panel = await waitFor(() => screen.getByRole("alert", { name: "Save conflict" }));
    expect(panel.textContent).toContain("changed");
    expect(panel.textContent).toContain("changed on disk");
    const actions = within(panel).getAllByRole("button");
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Reload from disk",
      "Overwrite",
    ]);
  });

  it("says why an overwrite cannot start instead of dropping the conflict panel", async () => {
    const validatePlaybook = vi.fn(async () => verdict());
    const savePlaybook = vi.fn(async () => {
      throw new ArgosApiError("playbook_conflict", "the playbook changed on disk", 409, {
        reason: "changed",
      });
    });
    await openEditor({ validatePlaybook, savePlaybook });
    await edit(validatePlaybook);
    await waitFor(() => expect(saveButton()?.disabled).toBe(false));
    await fireEvent.click(saveButton() as HTMLButtonElement);
    const panel = await waitFor(() => screen.getByRole("alert", { name: "Save conflict" }));
    expect(savePlaybook).toHaveBeenCalledTimes(1);

    // The buffer is edited into an invalid one while the panel is open, so no save can start.
    validatePlaybook.mockImplementation(async () =>
      verdict({
        valid: false,
        errors: [{ file: FILE, code: "playbook_invalid", message: "the playbook is broken" }],
      }),
    );
    await fireEvent.input(textarea(), { target: { value: `${EDITED}\n  bad: [\n` } });
    await waitFor(() => expect(validatePlaybook).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(saveButton()?.disabled).toBe(true));

    await fireEvent.click(within(panel).getByRole("button", { name: "Overwrite" }));
    // The panel survives (nothing was saved) and a notice carries the model's own sentence, so the
    // operator is never left with a vanished panel and no message.
    expect(screen.getByRole("alert", { name: "Save conflict" })).toBe(panel);
    const notices = screen.getAllByRole("alert").filter((alert) => alert !== panel);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toContain("Fix the issues before saving");
    expect(savePlaybook).toHaveBeenCalledTimes(1);
  });

  it("offers no Save for a read-only home playbook", async () => {
    await openEditor({}, "/home/me/.argos/playbooks/home.yaml");
    expect(saveButton()).toBeNull();
    expect(screen.getByText("read-only")).toBeTruthy();
  });

  it("shows the refusal code when the file cannot be read, never an empty editor", async () => {
    render(PlaybookEditor, {
      props: {
        cwd: CWD,
        file: FILE,
        api: api({
          getPlaybookFile: async () => {
            throw new ArgosApiError("invalid_request", "file is not a discovered playbook", 400);
          },
        }),
      },
    });
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("invalid_request");
    expect(alert.textContent).toContain("not a discovered playbook");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
