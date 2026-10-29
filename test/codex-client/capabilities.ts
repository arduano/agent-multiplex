import type { CodexReadClient, CodexViewPort } from "../../src/codex/client/index.js";

/** Compile-only capability boundary: this owner cannot dispatch native work. */
export function readOnlyCapabilities(client: CodexReadClient, view: CodexViewPort): void {
  // @ts-expect-error Native effects stay on the application's actual Codex router.
  client.turn.start.mutate({});
  // @ts-expect-error A child/root observation view never owns native Stop.
  view.stop();
}
