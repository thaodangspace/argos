/**
 * The jsdom polyfills Zag.js needs (spec FR19), for the three Skeleton escalations — `Dialog` and
 * `Toast.Group` — whose state machines focus, trap, measure, and animate.
 *
 * It is guarded by `typeof window !== "undefined"`, so the Node-environment files (the pure
 * projections, the guards, the API/SSE clients) import it and do nothing. `environment: "node"`
 * stays the default and every component test keeps its own `// @vitest-environment jsdom` docblock,
 * so only a test that already opted into a DOM pays for these shims.
 *
 * Every shim is installed **only when jsdom lacks it**: a future jsdom that ships one keeps its own.
 */

/** Install a value over a read-only/absent global without fighting the DOM lib's types. */
function defineValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

/** A `MediaQueryList` that never matches; Zag only asks whether a query exists, never its result. */
function mediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const list = {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void): void => {
      listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void): void => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void): void => {
      listeners.delete(listener);
    },
    dispatchEvent: (): boolean => true,
  };
  return list as unknown as MediaQueryList;
}

/** `ResizeObserver`/`IntersectionObserver`: Zag registers callbacks and never needs a measurement. */
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/** A resolved `Animation`: Zag's presence helpers await `finished` and call `cancel`. */
function animationStub(): Animation {
  const animation = {
    currentTime: 0,
    playState: "finished",
    finished: Promise.resolve(),
    cancel(): void {},
    finish(): void {},
    play(): void {},
    pause(): void {},
    reverse(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent: (): boolean => true,
    onfinish: null,
  };
  return animation as unknown as Animation;
}

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    defineValue(window, "matchMedia", (query: string): MediaQueryList => mediaQueryList(query));
  }

  if (typeof globalThis.ResizeObserver !== "function") {
    defineValue(globalThis, "ResizeObserver", ObserverStub);
  }

  if (typeof globalThis.IntersectionObserver !== "function") {
    defineValue(globalThis, "IntersectionObserver", ObserverStub);
  }

  if (typeof window.requestAnimationFrame !== "function") {
    // A rAF timestamp is a `performance.now()` reading, not an epoch one: Zag's timers subtract two
    // of them, and a `Date.now()` value would make every animation look already finished.
    defineValue(window, "requestAnimationFrame", (callback: FrameRequestCallback): number =>
      setTimeout(() => callback(performance.now()), 16) as unknown as number,
    );
  }

  if (typeof window.cancelAnimationFrame !== "function") {
    defineValue(window, "cancelAnimationFrame", (handle: number): void => {
      clearTimeout(handle);
    });
  }

  const element = window.Element.prototype;

  if (typeof element.scrollIntoView !== "function") {
    defineValue(element, "scrollIntoView", function scrollIntoView(): void {});
  }

  if (typeof element.hasPointerCapture !== "function") {
    defineValue(element, "hasPointerCapture", function hasPointerCapture(): boolean {
      return false;
    });
  }

  if (typeof element.setPointerCapture !== "function") {
    defineValue(element, "setPointerCapture", function setPointerCapture(): void {});
  }

  if (typeof element.releasePointerCapture !== "function") {
    defineValue(element, "releasePointerCapture", function releasePointerCapture(): void {});
  }

  if (typeof element.animate !== "function") {
    defineValue(element, "animate", function animate(): Animation {
      return animationStub();
    });
  }

  const css = (globalThis as { CSS?: { supports?: unknown } }).CSS;
  if (css === undefined) {
    defineValue(globalThis, "CSS", { supports: (): boolean => false });
  } else if (typeof css.supports !== "function") {
    defineValue(css, "supports", (): boolean => false);
  }
}
