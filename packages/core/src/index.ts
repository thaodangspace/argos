export const PACKAGE_NAME = "argos-core";

export {
  ARGOS_ERROR_CODES,
  ArgosError,
  argosError,
  errorLocation,
  isArgosError,
  type ArgosErrorCode,
  type ArgosErrorDetails,
} from "./errors.js";

export {
  ARGOS_HOME_MODE,
  ARGOS_TOKEN_MODE,
  argosHome,
  dbPath,
  ensureHome,
  pidPath,
  tokenPath,
} from "./paths.js";

export * from "./playbook/index.js";
