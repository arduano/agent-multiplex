import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { defineHost, defaultLifecycle, existingDirectoryWorkspace } from "../../src/host/index.js";
import type { PublicHostContract } from "../../src/host/contracts.js";
import type { OriginalJournalPort } from "../../src/storage/contracts.js";
import type { CodexNative } from "../../src/codex/node-contracts.js";
import type { CopilotNative } from "../../src/copilot/node-contracts.js";

/** Compile-only concrete host/lifecycle composition; neither adapter is opened. */
function concreteContracts(
  codex: CodexNative,
  copilot: CopilotNative,
  codexJournal: OriginalJournalPort,
  copilotJournal: OriginalJournalPort,
) {
  const codexLifecycle = defaultLifecycle({
    native: codex,
    journal: codexJournal,
    workspace: existingDirectoryWorkspace(),
    selection: { model: "codex-model" },
  });
  const copilotLifecycle = defaultLifecycle({
    native: copilot,
    journal: copilotJournal,
    workspace: existingDirectoryWorkspace(),
    selection: { model: "copilot-model" },
  });
  const first = defineHost({
    contract: { id: "codex", version: 1 },
    harness: { identity: codex.identity, nativeKind: "codex", capabilities: [] },
    lifecycle: () => codexLifecycle,
  });
  const second = defineHost({
    contract: { id: "copilot", version: 1 },
    harness: { identity: copilot.identity, nativeKind: "copilot", capabilities: [] },
    lifecycle: () => copilotLifecycle,
  });
  type CodexInputs = inferRouterInputs<PublicHostContract<typeof first>["router"]>["lifecycle"];
  type CopilotInputs = inferRouterInputs<PublicHostContract<typeof second>["router"]>["lifecycle"];
  type CodexOutput = inferRouterOutputs<PublicHostContract<typeof first>["router"]>["lifecycle"];
  type CopilotOutput = inferRouterOutputs<PublicHostContract<typeof second>["router"]>["lifecycle"];
  const codexCreate: CodexInputs["create"] = {
    session: "s",
    id: "c",
    workspace: { cwd: "/workspace" },
    selection: {
      kind: "codex",
      model: "m",
      access: { approval: "on-request", sandbox: "danger-full-access" },
    },
  };
  const copilotCreate: CopilotInputs["create"] = {
    session: "s",
    id: "c",
    workspace: { cwd: "/workspace" },
    selection: { kind: "copilot", model: "m", permissions: "manual", mode: "plan" },
  };
  // @ts-expect-error Copilot native selection cannot be passed through Codex Create
  const crossSelection: CodexInputs["create"] = copilotCreate;
  const checkState = (codexState: CodexOutput["state"], copilotState: CopilotOutput["state"]) => {
    if (codexState.selectionSource === "observed") {
      const model: string | undefined = codexState.selection.model;
      // @ts-expect-error native permission facts may be absent and cannot be assumed full access
      const permissions: object = codexState.selection.access;
      void [model, permissions];
    }
    if (copilotState.selectionSource === "observed") {
      const provider: string | null = copilotState.selection.nativeProviderId;
      const mode: "interactive" | "plan" | "autopilot" = copilotState.selection.mode;
      // @ts-expect-error Codex permission controls are not Copilot native fields
      void copilotState.selection.access;
      void [provider, mode];
    }
  };
  void [first, second, codexCreate, copilotCreate, crossSelection, checkState];
}
void concreteContracts;
