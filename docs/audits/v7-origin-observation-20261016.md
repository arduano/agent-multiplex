# V7 origin-observation owner candidate — October 16, 2026

The additive `observation.origin-liveness/v1` contract exposes separate Root
and Host/session observed streams. Legacy streams keep their existing item
vocabularies. Consumers must negotiate actual peer support; Root forwards Host
heartbeats rather than replacing them with its own. Heartbeats run every ten
seconds and carry exact producer boot, session and attachment identities.

Host watermarks distinguish received native presentation from its contiguous
materialized prefix. Rejection, overflow or failed externalization leaves an
explicit gap; a later successful event cannot erase a missing ordinal. Status
and interaction ingress remain independent of presentation work. Heartbeats
consume no native cursor, catalog revision or durable writer operation. Timer
cleanup includes abort while an observer is paused.

Disposable tests cover held materialization with healthy critical ingress,
failed and overflowing presentation, old-peer legacy compatibility, Root
forwarding and listener cleanup. These tests make no model calls and do not
modify installed/native state. Full exact-source repository and artifact gates
are recorded by the publishing consumer under its protected receipts; this
candidate is not an official registry/native-fleet qualification claim.

The personal application adds a scoped cached freshness query and separate
browser history catch-up. Its rollout authority is NAS Gateway only; Host and
Root services remain on their existing artifacts. Published code does not
mean those producer features have been activated. Transport and stored native
state are unchanged. Original-ID command ownership and action uncertainty
remain separate from presentation freshness.
