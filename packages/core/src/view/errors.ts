/**
 * The one view error shape (spec FR6): a stable code plus a message, never a prose status.
 *
 * The Paseo plugin adapts its `PluginRpcError` into this, and the web UI adapts an `ArgosApiError`
 * into the same shape, so both render the same code.
 */
export interface PanelError {
  readonly code: string;
  readonly message: string;
}
