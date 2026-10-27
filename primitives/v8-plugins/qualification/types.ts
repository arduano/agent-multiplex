import type { TRPCClient } from "@trpc/client";
import type { PublicHostContract } from "../src/index.js";
import { defineHost, HostActivationError } from "../src/index.js";
import { fixture } from "./fixtures.js";

const definition = fixture().definition;
type Public = PublicHostContract<typeof definition>;
declare const client: TRPCClient<Public["router"]>;
declare const create: Public["createInput"];
declare const session: Public["sessionData"];
declare const extension: Public["extensions"]["workspace"]["sessionData"];
function assertType<T>(_value: T): void {}
assertType<string>(create.workspace.directory);
assertType<string>(session.directory);
assertType<string>(extension.branch);
assertType<Promise<{ directory: string; bytes: number }>>(client.extensions.workspace.inspect.query());
void client.extensions.workspace.claim.submit.mutate({ id: "id", input: { label: "label" } });
void client.harness.thinking.mutate({ effort: "high" });
// @ts-expect-error Adapter-specific method is absent.
void client.harness.copilotMode.mutate({ mode: "plan" });
// @ts-expect-error Custom input retains schema inference.
void client.extensions.workspace.claim.submit.mutate({ id: "id", input: { label: 42 } });
// @ts-expect-error Custom output retains schema inference.
assertType<string>(extension.missing);
// @ts-expect-error Native-only fields are absent from the public contract.
type PrivateLeak = Public["storage"];
// @ts-expect-error One selected lifecycle is mandatory.
defineHost({ contract: definition.contract, harness: definition.harness });
// @ts-expect-error One selected harness is mandatory.
defineHost({ contract: definition.contract, lifecycle: definition.lifecycle });

declare const activationError: HostActivationError;
const retained = activationError.recoveryFor(definition);
if (retained) {
  assertType<string>(retained.sessions.publicValue);
  // @ts-expect-error Recovery retains the selected lifecycle owner type.
  retained.sessions.copilotOnlyAction();
}
