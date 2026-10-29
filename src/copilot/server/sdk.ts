import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPILOT_SDK_VERSION, COPILOT_CLI_VERSION } from "../contracts.js";
import { check, object } from "./validation.js";
import type { ClientInput, SdkClient } from "../sdk-contracts.js";
/** The exact published SDK declaration graph currently has strict TS conflicts.
 * Keep its dynamic boundary narrow; every relevant response is decoded locally. */
export async function realSdkClient(input: ClientInput): Promise<SdkClient> {
  const source = import.meta.resolve("@github/copilot-sdk");
  const metadata = JSON.parse(
    await readFile(join(dirname(dirname(fileURLToPath(source))), "package.json"), "utf8"),
  ) as Record<string, unknown>;
  check(
    metadata.name === "@github/copilot-sdk" &&
      metadata.version === COPILOT_SDK_VERSION &&
      metadata.copilotCliVersion === COPILOT_CLI_VERSION,
    "SDK_PIN",
  );
  const module = object(await import(source));
  check(typeof module.CopilotClient === "function", "SDK_EXPORT");
  const runtime = object(module.RuntimeConnection);
  check(typeof runtime.forStdio === "function", "SDK_EXPORT");
  const Client = module.CopilotClient as new (options: unknown) => SdkClient;
  return new Client({
    connection: (runtime.forStdio as (input: unknown) => unknown)({
      path: input.launcher,
      env: { ...input.environment },
    }),
    mode: "copilot-cli",
    workingDirectory: input.cwd,
    baseDirectory: input.home,
    useLoggedInUser: false,
    logLevel: "error",
  });
}
