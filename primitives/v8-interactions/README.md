# V8 interaction primitives

Isolated native callback ownership and retained headless confirmation state.
This lane composes the qualified SessionHost original-response journal; it adds
no durable callback reconstruction, native lifetime controller or policy service.

- `src/contracts.ts`: concrete Codex/Copilot prompts and typed answers.
- `src/native.ts`: bounded native normalization and offered-response encoding.
- `src/owner.ts`: exact native-run callback owner, one-response capabilities,
  positive baseline, Host NativeRun/event bridge and native-proof retirement.
- `src/client.ts`: retained immutable external store, read-only reconnect and
  original receipt checks. Exact-capability `form(scope,prompt)` handles retain
  bounded private drafts in RAM outside public snapshots. React rendering is
  supplied by the embedding.
- `qualification`: unique Node oracles, actual SQLite SessionHost composition,
  static wrong-harness assertions and a bounded real Chromium DOM popup fixture.

The browser entry is `src/index.ts`. The native owner is browser-safe code so
scripted fixtures can run in Chromium; deployment instantiates it beside trusted
native adapters on the Host. Its callback closures and private source tokens are
never serialized or reconstructed from history. Rich prompt snapshots are
authenticated volatile observations, not browser-persistent records.

Initial `bind(scope)` calls coalesce subscription admission and baseline reading. A failed subscription rolls back the exact entry; a failed snapshot retains the valid subscription as stale, and an explicit bind retries the missing read. One entry persists across native generations so unresolved original responses remain exact-checkable. Namespace close fences work first, scrubs cached views and private forms, notifies retained facades, and continues cleanup after an unsubscribe failure. Late callbacks cannot repopulate a replaced or disposed entry.

Primitive elicitation schemas reject overlapping string `oneOf` constants rather than weakening exclusive-choice semantics. Unsupported forms still expose native decline/cancel; distinct constants may have identical display titles.

Run `npm run typecheck`, `npm run build`, then `npm test` within this folder.
The browser helper exports `runBrowserQualification({buildRoot?})` for the owner’s
single frozen combined gate. No model/provider/live-session calls are included.

The framework [interaction ownership contract](../../docs/design/v8-architecture.md#interactions-and-mcp)
keeps exact prompts, response originals and observers separate. Scripted
acceptance does not establish every real native popup or callback-continuity
path. Native and transport proof boundaries remain distinct.
