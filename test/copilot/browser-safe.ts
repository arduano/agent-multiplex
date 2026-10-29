import {
  copilotSelectionSchema,
  copilotCommandSchema,
  type CopilotSelection,
  type CopilotAsset,
} from "../../src/copilot/index.js";
// @ts-expect-error Private native construction is not a browser export.
import type { createCopilotAdapter as _createCopilotAdapter } from "../../src/copilot/index.js";
const selected: CopilotSelection = copilotSelectionSchema.parse({ model: "copilot-model" });
const abort = copilotCommandSchema.parse({ type: "abort" });
const unavailable: CopilotAsset = {
  id: "asset",
  name: "Image",
  mediaType: "image/png",
  state: "unavailable",
  reason: "noMaterializer",
};
void selected;
void abort;
void unavailable;
// @ts-expect-error No filesystem global may leak through the browser declaration graph.
const filesystem: typeof process = undefined;
void filesystem;
