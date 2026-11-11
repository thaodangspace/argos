import { argosHome } from "argos-core";

/** Name of the CLI binary surfaced in Phase 8. */
export const CLI_NAME = "argos";

/**
 * Minimal entry point stub. Phase 8 adds the commands; for now it only proves
 * that the CLI resolves `argos-core` through the workspace link.
 */
export function describeEnvironment(): string {
  return `${CLI_NAME} home: ${argosHome()}`;
}
