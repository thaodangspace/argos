/**
 * Transient action feedback (spec FR14): every failure is shown with its stable code, never prose.
 * A toast never replaces the page state — the page always re-reads after an action.
 */

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
  readonly code?: string;
}

export const TOAST_TTL_MS = 6_000;

export class ToastStore {
  items = $state<Toast[]>([]);
  #nextId = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(message: string, options: { readonly tone?: ToastTone; readonly code?: string } = {}): number {
    const id = this.#nextId++;
    this.items = [
      ...this.items,
      {
        id,
        tone: options.tone ?? "info",
        message,
        ...(options.code === undefined ? {} : { code: options.code }),
      },
    ];
    const timer = setTimeout(() => {
      this.dismiss(id);
    }, TOAST_TTL_MS);
    this.#timers.set(id, timer);
    return id;
  }

  dismiss(id: number): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    this.items = this.items.filter((toast) => toast.id !== id);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.items = [];
  }
}
