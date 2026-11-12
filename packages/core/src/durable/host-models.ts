/**
 * D6: the durable host's model stand-in (FR5.2 split of `host.ts`).
 *
 * The engine never consults a model for control flow, so the harness is opened with a `Models`
 * that fails loudly on any use. No `pi.generation` task can be scheduled because nothing ever
 * obtains a model.
 */

import type { Models } from "@earendil-works/pi-ai/models";

/** Messages used by the D6 guard: the stub must fail loudly, never silently. */
const STUB_MODELS_MESSAGE =
  "argos: the durable host has no model access; control flow is decided by the engine (FR21)";

/**
 * D6: a `Models` stand-in that throws on any use. `Harness.open` reads `getAuth` once (to bind
 * it into its identity wrapper), so the property must exist — calling it throws like everything
 * else. No `pi.generation` task can be scheduled because nothing ever obtains a model.
 */
export function createStubModels(): Models {
  const touched = (): never => {
    throw new Error(STUB_MODELS_MESSAGE);
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || property === "then" || property === "toJSON") {
          return undefined;
        }
        // `Harness.open` binds `getAuth` once into its identity wrapper; that binding is the only
        // eager read. Calling it (or reading any other member) fails loudly.
        if (property === "getAuth") return touched;
        throw new Error(STUB_MODELS_MESSAGE);
      },
      // `withClientIdentity` checks `"setProvider" in models`; a false answer keeps the wrapper
      // read-only, which is all the stub needs to be.
      has: () => false,
    },
  ) as unknown as Models;
}
