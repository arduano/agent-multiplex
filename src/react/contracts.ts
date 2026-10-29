import type { AnchorPort } from "../client/contracts.js";
export interface AnchoredViewPort {
  readonly anchor: AnchorPort;
}
export type { SessionViewPort, TranscriptViewPort } from "../client/contracts.js";
