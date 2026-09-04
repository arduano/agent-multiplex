# Lifecycle, metadata, archive, and search

Logical session lifecycle and transient harness status are intentionally
different. Display the three user-facing states from catalog state and binding
availability; do not infer them from one native status string.

## Session states

| User state | Durable representation | Default visibility | Main actions |
| --- | --- | --- | --- |
| Running | `catalogState=open`, active binding | Hot snapshots and default search | Prompt, steer, interrupt, settings, interactions, stop |
| Stopped | `catalogState=open`, non-active binding | Hot snapshots and default search | Resume, metadata, native history when provider can attach, archive |
| Archived | `catalogState=archived`, archive time and higher catalog revision | Explicit cold search/get only | Metadata and search; no native actions without a future restore design |

An unreachable open binding appears in the stopped bucket so it remains visible,
but archive admission is stricter: the binding must be non-active and the
runtime status must explicitly be `stopped`.

Stop preserves the logical ID, vendor binding, launch provenance, and provider
resources required for resume. Archive is never automatic and is not the same
as Codex's own native thread-archive concept.

## Launch lifecycle

`launches.create` durably admits work before asynchronous provisioning:

```text
accepted -> preparing -> nativeStarting -> succeeded
                   \-> cleanupPending -> failed
          ambiguous external/native effect -> outcomeUnknown
```

The initial response may be non-terminal. Use `launches.get`, bounded
`launches.list`, or `launches.watch`. Launch success and native binding commit in
one runtime transaction. An interrupted `nativeStarting` operation is not
replayed blindly because the native session may already exist.

## Archive lifecycle

Archive requires a stopped session and the current binding and authority fences:

```text
accepted -> releasing backend -> releasing provider -> succeeded
                              \-> failed | outcomeUnknown
```

Progress flags make release restart-safe. Success atomically writes the runtime
binding tombstone and removes the live binding; only then does the metadata
authority publish the archived catalog revision. A failed or ambiguous cleanup
leaves the logical session stopped. Later native inventory cannot resurrect a
tombstoned binding.

## Metadata model

Metadata is one flat namespaced map. Keys look like `agent.title`,
`work.item`, or `review.pull_request`; values may be any JSON value. Nested JSON
inside a value is allowed, but there are no nested metadata documents or
server-defined workflow tables.

Every patch has:

- retry-stable `operationId` and `sessionId`;
- the complete expected realm/control/epoch authority fence;
- `set` and/or `remove` keys;
- optional `ifKeyRevision` compare-and-set expectations.

Statuses are `queued`, `accepted`, `conflicted`, or `outcomeUnknown`. Only the
authority assigns canonical document and per-key revisions. Both a client and
runtime-side agent integration may propose changes through the same mechanism.
Attached branches can queue optimistic work while disconnected but cannot
promote themselves.

Archived metadata remains authority-owned and searchable. A patch to an
archived row updates the cold catalog and search index, but is never delivered
to the released runtime. Archiving retires any pending runtime metadata-delivery
intent.

Do not use metadata for transcripts, secrets, terminal output, provider-private
checkpoints, or large workflow state.

## Search

`sessions.search` defaults to running and stopped sessions. It supports:

- any explicit combination of `running`, `stopped`, and `archived`;
- runtime node and harness;
- launch provider and profile;
- last-activity bounds;
- up to 32 AND-combined metadata predicates;
- namespaced-key `exists` and canonical structural JSON `equals`.

Existence includes a value of `null`; missing and `null` are distinct. Structural
equality ignores object-key order, not array order. Pages contain at most 500
rows and cursors are bound to the exact query, authority epoch, and gateway
source/feed selection. Do not reuse a cursor after changing a filter.

```bash
# Open work is the default.
npm run dev:cli -- sessions --metadata-exists work.item

# Cold archived search by structural metadata.
npm run dev:cli -- sessions --state archived \
  --metadata-equals 'review.pull_request={"number":42,"repo":"org/project"}'
```

An aggregate recursively searches children so archives created before
attachment remain discoverable. The same session identity returned by two
sibling subtrees is a conflict, not a deduplication opportunity.

## History and interactions

`sessions.readNativeHistory` always routes to the recorded provider/backend and
harness adapter. Multiplex does not read `.codex`, Copilot session files, or
terminal scrollback. Preserve native payloads and pagination semantics.

Pending approvals and user questions are interaction records. Respond with the
harness-native response shape and current session/binding route. Stop retires
pending interactions for the old runtime handle so a late response cannot reach
a replacement binding.
