import { prepareCodexImage, prepareCopilotImage } from "../src/native/index.js";
import type { ArtifactRef, FileScope } from "../src/contracts/types.js";
declare const scope: FileScope, artifact: ArtifactRef, bytes: Uint8Array;
if (false) {
  void prepareCodexImage({ harness: "codex", scope, artifact, bytes });
  void prepareCopilotImage({ harness: "copilot", scope, artifact, bytes });
  // @ts-expect-error Copilot controls cannot enter the Codex native preparation.
  void prepareCodexImage({ harness: "copilot", scope, artifact, bytes });
  // @ts-expect-error Codex inputs cannot enter the Copilot native preparation.
  void prepareCopilotImage({ harness: "codex", scope, artifact, bytes });
}
