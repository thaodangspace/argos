/**
 * The one view error shape (spec FR6): a stable code plus a message, never a prose status.
 *
 * The web UI adapts an `ArgosApiError` into this shape, and the CLI its exit code, so every client
 * renders the same stable code.
 */
export interface PanelError {
  readonly code: string;
  readonly message: string;
}
