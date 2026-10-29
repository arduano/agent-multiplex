import { z } from "zod";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { defaultLifecycle, defineHost, existingDirectoryWorkspace } from "../../src/host/index.js";
import type { NativePort, PublicHostContract } from "../../src/host/contracts.js";
import type { OriginalJournalPort } from "../../src/storage/contracts.js";

const command = z.object({ type: z.literal("continue") });
const message = z.object({ text: z.string(), files: z.array(z.string()) }).strict();
const requested = z
  .object({ kind: z.literal("first"), model: z.string(), mode: z.literal("plan") })
  .strict();
const observed = z
  .object({
    kind: z.literal("first"),
    model: z.string().optional(),
    permissions: z.enum(["known", "unknown"]),
  })
  .strict();

/** Compile-only actual router contract. Definitions remain inert. */
function verify(
  native: NativePort<typeof command, typeof message, typeof requested, typeof observed>,
  journal: OriginalJournalPort,
) {
  const lifecycle = defaultLifecycle({
    native,
    journal,
    workspace: existingDirectoryWorkspace(),
    selection: { kind: "first", model: "model", mode: "plan" },
  });
  const definition = defineHost({
    contract: { id: "test", version: 1 },
    harness: {
      identity: { id: "first", version: 1, recordVersion: 1 },
      nativeKind: "first",
      capabilities: [],
    },
    lifecycle: () => lifecycle,
  });
  type Contract = PublicHostContract<typeof definition>;
  type Input = inferRouterInputs<Contract["router"]>["lifecycle"];
  type Output = inferRouterOutputs<Contract["router"]>["lifecycle"];
  const create: Input["create"] = {
    session: "s",
    id: "i",
    workspace: { cwd: "/tmp" },
    selection: { kind: "first", model: "model", mode: "plan" },
  };
  const otherCreate: Input["create"] = {
    ...create,
    // @ts-expect-error native selection discriminant belongs to this Host
    selection: { kind: "second", model: "model", mode: "plan" },
  };
  // @ts-expect-error required requested fields cannot be replaced by partial observed facts
  const partialCreate: Input["create"] = { ...create, selection: { kind: "first" } };
  const checkOutput = (state: Output["state"]) => {
    if (state.selectionSource === "observed") {
      const model: string | undefined = state.selection.model;
      const permission: "known" | "unknown" = state.selection.permissions;
      // @ts-expect-error requested mode is not an observed fact
      void state.selection.mode;
      void [model, permission];
    } else {
      const model: string = state.selection.model;
      const mode: "plan" = state.selection.mode;
      // @ts-expect-error requested selection does not invent observed permissions
      void state.selection.permissions;
      void [model, mode];
    }
  };
  void [
    command,
    message,
    requested,
    observed,
    definition,
    create,
    otherCreate,
    partialCreate,
    checkOutput,
  ];
}
void verify;
