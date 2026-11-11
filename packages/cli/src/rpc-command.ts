/** Shared RPC command plumbing: one client per command, one place for error mapping. */

import { RpcClient, RpcClientError } from "argos-core/rpc";

import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_UNREACHABLE,
  EXIT_VALIDATION,
  classifyFailure,
  describeRpcError,
  isValidationCode,
  printJson,
  printJsonError,
  type CliIo,
} from "./output.js";

export interface RpcCommandResult {
  /** The stable `--json` shape. */
  readonly jsonValue: unknown;
  /** Concise human output (a trailing newline is added when missing). */
  readonly human: string;
}

/** Open the client, run one action, and render either success or a mapped failure. */
export async function withRpc(
  io: CliIo,
  json: boolean,
  action: (client: RpcClient) => Promise<RpcCommandResult>,
): Promise<number> {
  const client = new RpcClient();
  try {
    const result = await action(client);
    if (json) printJson(io, result.jsonValue);
    else io.stdout(result.human.endsWith("\n") ? result.human : `${result.human}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof RpcClientError) {
      const message = describeRpcError(error, client.baseUrl, client.home);
      if (json) printJsonError(io, error.unreachable ? "unreachable" : error.code, message);
      else io.stderr(`argos: ${message}\n`);
      if (error.unreachable || error.unauthorized) return EXIT_UNREACHABLE;
      return isValidationCode(error.code) ? EXIT_VALIDATION : EXIT_RUNTIME;
    }
    const failure = classifyFailure(error);
    if (json) printJsonError(io, failure.code, failure.message);
    else io.stderr(`argos: ${failure.message}\n`);
    return failure.exitCode;
  }
}
