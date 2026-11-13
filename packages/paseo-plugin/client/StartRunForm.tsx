/** Collapsible "Start run" form: playbook id, optional cwd, inputs as key=value lines or JSON. */

import { useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";

import { parseStartForm, type PanelStore } from "../shared/panel";
import { buttonStyle, fieldStyle } from "./ui";

export function StartRunForm({
  theme,
  panel,
  starting,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  starting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [playbookId, setPlaybookId] = useState("");
  const [cwd, setCwd] = useState("");
  const [inputs, setInputs] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        style={buttonStyle(theme, "accent")}
      >
        + New run
      </button>
    );
  }

  const submit = (): void => {
    const parsed = parseStartForm({ playbookId, cwd, inputs });
    if (!parsed.ok) {
      setFormError(parsed.error.message);
      return;
    }
    setFormError(null);
    void panel.startRun(parsed.request).then((outcome) => {
      if (outcome.started !== undefined) {
        setOpen(false);
        setPlaybookId("");
        setInputs("");
      }
    });
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 12 }}>Start run</strong>
      <input
        value={playbookId}
        placeholder="playbook id (file name without .yaml)"
        onChange={(event) => {
          setPlaybookId(event.target.value);
        }}
        style={fieldStyle(theme)}
      />
      <input
        value={cwd}
        placeholder="cwd (optional, default: the server's cwd)"
        onChange={(event) => {
          setCwd(event.target.value);
        }}
        style={fieldStyle(theme)}
      />
      <textarea
        value={inputs}
        rows={3}
        placeholder={'inputs: key=value per line, or {"key": 1}'}
        onChange={(event) => {
          setInputs(event.target.value);
        }}
        style={{ ...fieldStyle(theme), fontFamily: "monospace", resize: "vertical" }}
      />
      {formError === null ? null : (
        <div style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{formError}</div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" disabled={starting} onClick={submit} style={buttonStyle(theme, "accent", starting)}>
          {starting ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          disabled={starting}
          onClick={() => {
            setOpen(false);
            setFormError(null);
          }}
          style={buttonStyle(theme, "neutral", starting)}
        >
          Close
        </button>
      </div>
    </div>
  );
}
