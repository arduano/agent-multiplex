# V8 session organization

Small browser-safe helpers over the actual retained catalog/session/history
clients. This lane adds no authority, transcript, operation ledger, native
lifetime owner, database or search service.

- `queryCatalog(catalog.catalog(), scope, query, pinnedIds)` performs bounded
  metadata search, exact harness/Host/binding filters and deterministic sorting.
  Input must be validated `CatalogWorkspace` entries, not arbitrary wire data.
  Result coverage is always `observed`; an empty/partial refresh cannot delete.
- `SessionPins({ catalog, scope, storage?, maxPins? })` keeps browser preferences
  under the complete connection/principal/authority key. Pin writes delegate to
  the real `CatalogWorkspace.setPinned`. `snapshot()` distinguishes `background`
  actual bound retention, `provisional` no-native-binding-yet, and `notHeld`
  unsuccessful restored preference. It never binds native history itself.
- `setPinned` reports persistence separately from retention. Underlying capacity
  refusal throws before claiming success or writing storage. Storage failure
  leaves visit-only retention in effect and returns `unavailable`.
- Explicit additive `restore()` validates the full record before effects, exposes
  each blocked pin and never releases protected peers to compensate. Pending
  restored preferences survive later saves within the preference budget. An
  over-budget union refuses before effects and preserves the saved record for
  explicit retry. No implicit mount side effects.

Use one preference writer per retained workspace and perform writes through this
facade. No cross-tab/device synchronization or React subscription store is added.
The caller owns storage injection and refresh/render scheduling. Sorting pages
are offsets over the supplied metadata set, not durable cursors across renames or
new publications. No latest-activity sort is fabricated from catalog versions.

Default limit: eight preferred pins, configurable to 128; list input at most 512
entries, query text 256 code units, output page at most 100. Capacity refusal
does not evict sessions, originals, drafts or pins. List and pin operations never
Create/Send/Stop/Resume/archive/delete. Native capture and receipt settlement do
not depend on selection, a pin or browser observation.

The root isolated composition gate owns source-bound qualification. Nine unique
focused invariants use the actual retained clients and scripted native facts;
they make zero model/native calls. Archive/delete orchestration is explicitly
deferred because neither V8 CatalogPort nor SessionHost exposes those effects.
See the framework [organization boundary](../../docs/design/v8-architecture.md#runtime-and-organization)
for its relationship to catalog, native lifetime and retained views.
