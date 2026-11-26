/**
 * Transient action feedback (spec FR14): every failure is shown with its stable code, never prose.
 * A toast never replaces the page state — the page always re-reads after an action.
 *
 * Since the Skeleton migration (spec FR12) the rendering is one document-wide `Toast.Group` in
 * `routes/+layout.svelte`, fed by `toaster` below. This module stays the **only** thing a page or a
 * run action touches: `push(msg, {tone, code})` appends to `items` (the page's own record) **and**
 * forwards to the toaster, so `items` and the toaster cannot disagree about which toasts exist.
 * The stable `code` is the toaster's description — never prose.
 */

import { createToaster } from "@skeletonlabs/skeleton-svelte";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
  readonly code?: string;
}

export const TOAST_TTL_MS = 6_000;

/**
 * The one toaster every store forwards to, rendered once by the layout. `placement`/`overlap` are
 * Zag's own vocabulary (bottom-right stack), so no positioning CSS has to exist in the app.
 */
export const toaster = createToaster({ placement: "bottom-end", overlap: false });

/** Zag's toast types are its own words; our tones map onto the three that carry a meaning here. */
const TOASTER_TYPE: Readonly<Record<ToastTone, "info" | "success" | "error">> = {
  info: "info",
  success: "success",
  error: "error",
};

export class ToastStore {
  items = $state<Toast[]>([]);
  #nextId = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** This store's local id → the toaster's id, so `dismiss` closes the right rendered toast. */
  #toasterIds = new Map<number, string>();

  push(message: string, options: { readonly tone?: ToastTone; readonly code?: string } = {}): number {
    const id = this.#nextId++;
    const tone = options.tone ?? "info";
    this.items = [
      ...this.items,
      {
        id,
        tone,
        message,
        ...(options.code === undefined ? {} : { code: options.code }),
      },
    ];
    // `duration` keeps Zag's auto-dismiss on the same TTL as this store's own timer; without it a
    // success toast would vanish after 2 s and an error after 5 s, while `items` kept both.
    const toasterId = toaster.create({
      title: message,
      description: options.code ?? "",
      type: TOASTER_TYPE[tone],
      duration: TOAST_TTL_MS,
    });
    this.#toasterIds.set(id, toasterId);
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
    const toasterId = this.#toasterIds.get(id);
    if (toasterId !== undefined) {
      this.#toasterIds.delete(id);
      toaster.dismiss(toasterId);
    }
    this.items = this.items.filter((toast) => toast.id !== id);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    // `remove()` is Zag's immediate clear (`dismiss()` animates out and leaves the store holding the
    // toast until the machine's remove delay elapses); `clear()` means "gone now", so use it.
    toaster.remove();
    this.#toasterIds.clear();
    this.items = [];
  }
}
