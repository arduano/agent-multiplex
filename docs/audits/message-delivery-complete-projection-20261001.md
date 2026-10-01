# Complete admission receipts in the pending delivery view

## Evidence and cause

On October 1, a read-only Leo owner-route capture of an active Codex binding on
`main-pc` found four old send/steer commands in `messageDeliveries`. Every
original receipt was `succeeded`, every command observation was
`delivery=accepted, continuation=complete`, and none had a causal native message
ID. The returned native turn IDs were now completed without an error, but that
does not prove consumption of a particular unidentified steer. No prompt text
or elapsed time was used as a delivery signal.

`RuntimeNodeService` filtered failed, consumed and settled commands but kept
successful admissions without an identity indefinitely. This disagreed with
the existing command-observation contract: no later native evidence can be
joined to those receipts safely, so further observation is complete.

## Narrow correction

The Host pending projection excludes a command only after matching its original
session, payload hash and succeeded receipt, accepted admission, absent native
message ID, and existing complete observation. It keeps all durable receipt and
lifecycle facts. It does not mark a command delivered, consumed, failed or
cancelled. Ambiguous receipts and identified admissions retain their previous
tracking behavior. Filtering precedes the 32-item bound and omitted count.

Wire and persisted schemas, lifecycle reducers, migrations, profile hashes,
vendor/transport dependencies and published `.24` artifacts are unchanged.
This is isolated source based on published `.24` source `d23d6ea`; it requires a
new package publication and consumer activation. No installed Host or owner
session was mutated, and no model was called.

## Qualification

The old projection fails three new regression cases: no-ID send, no-ID steer,
and retained receipts after runtime restart plus explicit resume. The corrected
source passes **27 tests / three files** with one worker: launch-provider,
lifecycle-journal and command-observation. The tests also preserve definitive
failure, no-ID ambiguity, same-text/exact-ID independence, and the pending bound
after 33 complete legacy admissions. Nearest runtime project TypeScript build
passes. Broader source/release/packed-consumer and installed acceptance gates
remain coordinator-owned.

Local receipt namespace: `receipts/b18-message-delivery-qualification-20261001`.

- Before-fix log SHA-256:
  `32ba3260d2c6bd463fc8ec9f920c4e8a87f518b72d227c6b68e10095d9b09534`.
- Corrected focused log SHA-256:
  `dbf56e80116b2d0eef47490895cf6ade69bf0b18f4366ba63b5fb2ee4e4fb6dd`.

The private live capture stays in Leo's ignored receipt tree. Its scrubbed
summary SHA-256 is
`3f43d72adf93fba6ad7a427e1443211c005b671c7874a501eda445fb76251e01`;
scrubbed native-turn summary SHA-256 is
`086e5500b56f195f4d15b30f8f60c19dd2de90282bddab224c6f93ea351a69df`.
Raw prompts/history and owner-route configuration are not release evidence.
