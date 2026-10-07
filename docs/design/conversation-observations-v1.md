# Native conversation observations v1

`NativeEvent.conversation` and `NativeHistoryResult.conversation` are optional
adapter-owned evidence alongside the unchanged native payload. They describe
items by identity and JSON pointer; they do not duplicate text, image sidecars
or files, or create another authoritative transcript database.

## Separate facts

| Fact | Contract | What it cannot prove |
| --- | --- | --- |
| Placement | Unknown, native event/predecessor, or scoped observation position | Snapshot freshness or persistence |
| Revision | Incomparable, immutable native record ID, or generation/sequence | Order between unrelated attachments |
| Completion | Open, settled, or unverified | Completion of an unrelated item or turn |
| Persistence | Native or ephemeral | Coverage of a read or replay window |
| Coverage | Unknown or explicitly owned observation through a sequence | A watermark inferred from read time |

The live effect owner uses `stampConversationObservation` with the actual
attachment generation and stream sequence. A history reader must not stamp a
snapshot with its arrival time. Equal immutable record IDs identify duplicates;
unrelated IDs without a proved relation remain incomparable. Codex history item
snapshots often lack a revision; a native turn terminal can prove completion
without inventing freshness. Copilot `parentId` describes event chronology,
never child ownership.

`compareConversationRevisions` and `compareConversationItems` are pure client
helpers. A settled exact item cannot reopen from a late start/delta. Two distinct
settled payloads without a proved revision relation remain incomparable.

`mergeConversationOrder` joins ordered runs only at exact item anchors. Previously
admitted native context stays in place; new older context precedes an unshared
ephemeral prefix at its anchor. Contradictory anchors retain the admitted order
and report a conflict. An omitted row does not certify deletion.

## Bounded reconciliation

Descriptors have a separate 192 KiB wire budget, at most 1,000 descriptors and
ordered IDs. `boundedConversationEvidence` can omit metadata without truncating
the native payload. Stamping also respects that budget. Oversized native identity
descriptors are omitted; native JSON remains available.

A consumer should retain one selected observation and at most one incomparable
alternative per item, under its existing transcript retention budget. Accumulate
live deltas separately from a native snapshot whose overlap is unknown. Text
prefixes, lengths, timestamps and content hashes do not prove revision order.
Raw native APIs and images stay authoritative; missing ephemeral records cannot
be reconstructed after an attachment restart.

The additive optional evidence is not permission to infer completeness on older
peers. Applications that need a strict active-only history contract must gate on
`history.explicit-inspection v1` and use an explicit inspection mutation for
stopped sessions. This capability is separate from conversation metadata.

## Qualification

`tests/conversation-evidence.test.ts` permutes native pages, retained native and
ephemeral prefixes, contradictory anchors, generation changes, terminal replay,
owner stamping and oversized metadata/identities. Its nine disposable cases and
protocol/client/adapter TypeScript builds pass in the architecture worktree.
Combined published-artifact qualification belongs to the release integration.
No live native SDK, model, fleet configuration or session is used by these cases.
