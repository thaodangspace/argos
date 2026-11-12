/**
 * One panel store per Argos connection, shared by the sidebar row and the screen. Both are mounted
 * at the same time, so a naive `createPanel()` per component would open two SSE streams; this
 * small ref-counted hub keeps one stream and disposes it when both contributions unmount.
 *
 * No React and no Node APIs: the panel model and the HTTP client are portable modules.
 */

import { createPanel, type PanelStore } from "./panel";
import { createArgosClient, type ArgosRpc } from "./rpc-client";

export interface PanelLease {
  readonly panel: PanelStore;
  release(): void;
}

interface Entry {
  readonly client: ArgosRpc;
  readonly panel: PanelStore;
  refs: number;
}

const entries = new Map<string, Entry>();

function keyOf(connection: { readonly url: string; readonly token: string }): string {
  return `${connection.url}\n${connection.token}`;
}

/** Acquire the shared panel for a connection. Every call must be paired with `release()`. */
export function acquirePanel(connection: { readonly url: string; readonly token: string }): PanelLease {
  const key = keyOf(connection);
  let entry = entries.get(key);
  if (entry === undefined) {
    const client = createArgosClient(connection);
    const panel = createPanel({ client });
    panel.start();
    void panel.load();
    entry = { client, panel, refs: 0 };
    entries.set(key, entry);
  }
  const current = entry;
  current.refs += 1;
  let released = false;
  return {
    panel: current.panel,
    release: () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (current.refs > 0) return;
      current.panel.dispose();
      current.client.close();
      entries.delete(key);
    },
  };
}

/** Tear down every shared panel (plugin teardown). Safe when nothing is open. */
export function disposeAllPanels(): void {
  for (const entry of entries.values()) {
    entry.panel.dispose();
    entry.client.close();
  }
  entries.clear();
}
