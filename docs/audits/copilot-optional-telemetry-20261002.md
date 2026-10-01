# Copilot optional telemetry admission candidate — October 2, 2026

## Evidence and scope

The consumer's October 1 capture proved three `wireEnvelope` rejections of
1,108,461, 2,257,381 and 2,062,694 pre-extraction event bytes. Two owner sessions
were idle with partial interaction hydration and Send blocked. Their rejected
original native type was not retained. This candidate does **not** retrospectively
identify that type or establish SDK/autopilot causation.

Source starts from exact published `.24` preparation
`d23d6ea1052d5b8318c9c5cade9fba235f97a8ee`. Package/native/transport pins,
wire bounds, strict durable/public lifecycle schemas and migrations are unchanged.
The candidate changes only source, disposable fixtures and maintained guidance;
no live Host, service, owner session, auth home or model was used.

## Narrow admission change

Pinned CLI `1.0.88` broadcasts `model.messages_snapshot`, an ephemeral diagnostic
copy of model context after the authoritative assistant turn end. SDK `1.0.14`
dispatches these native events without requiring membership in its generated
event union; that union does not declare this type. The existing image codec
already externalizes this exact shape's image content.

The adapter identifies optional telemetry only when wrapper/native types match
`model.messages_snapshot`, both ephemeral flags are explicitly true,
`data.kind` is `messages_snapshot`, and `data.messages` is an array. The runtime
also requires the Copilot harness, exact native type and explicit outer ephemeral
flag. Only an exact externalized `wireEnvelope` validation failure can preserve
lifecycle certainty. It still emits the native stream gap and private diagnostic;
it does not admit or truncate the rejected event, rewrite native history,
advance a native sequence for absent content or clear a previous genuine gap.

Other model/debug events, unknown types, malformed/mislabelled snapshots,
authoritative ephemeral requests and reverse callbacks keep ordinary fail-closed
invalidation. Serialization and queue-overflow failures are not exempted.
Real pending interactions retain their identity and continue blocking Send.

## Diagnostics and compatibility

The existing protected hook adds `nativeEventType`, `nativeEphemeral`,
`wireUpperBoundBytes`, `wireLimitBytes` and `lifecycleImpact` (`preserved` or
`invalidated`). The type is selected from 146 fixed Copilot event names or
`unknown`; arbitrary strings never enter logs. Bounds come from the **actual
externalized envelope** that failed parsing, not a raw-event estimate.
They are immutable safe integers. No payload, event ID, path, exception, provider
configuration or native session identity is logged.

These details do not enter the strict durable diagnostic or catalog projection.
Only ordinary authoritative failures persist `lastGap`; optional omission
preserves the prior lifecycle state and any previous diagnostic. Clients repair
native transcript gaps from supported history and read the runtime-owned
lifecycle view without inventing interaction invalidation.

## Qualification

- `npm run typecheck` passed.
- Focused suite passed **82 tests across six files**, covering admission,
  optional classification, image extraction/overflow, protocol envelopes and
  durable lifecycle reopen.
- On the untouched `.24` runtime production code, all **three** new observed-size
  optional regressions fail because continuity becomes `gap` and interaction
  completeness changes from `complete` to `partial`. They pass on the candidate.
- Candidate regressions preserve a real pending reverse request, fail closed on
  an oversized request/unknown event/mislabelling/missing policy, and show that
  later idle or optional telemetry cannot repair earlier genuine uncertainty.
  A second validation issue remains fail closed even when the existing fixed
  category priority reports `wireEnvelope`. Serialization, non-wire extraction,
  overflow and admitted-item/omission/admitted-item stream order are covered.
- Credential-free CLI `1.0.88`/SDK `1.0.14` loopback qualification confirms the
  optional native shape, all 30 ordinary native envelopes, one extracted image
  snapshot and native/resumed history. Only the local fixed completion fixture
  is called; **zero external models**. The executed Nix-patched CLI bytes and
  original package/source graph are hashed separately.

Local receipts remain ignored and protected. The baseline-state failure log is
`receipts/b17-qualification-20261002/baseline/optional-state-baseline.log`, SHA-256
`0f1c00c2c0ee84def59985748d55c61aaaccb5f3817621b5ab5f34cad7bff6c8`.
The candidate focused log is `receipts/b17-qualification-20261002/focused-final.log`,
SHA-256 `94ac9893ed8c4a8a8187b96ab65cb13f9f812541d7cfc0265a49e99611786df7`.
The final native receipt is
`receipts/copilot-offline-images/2026-10-01T14-36-41-650Z-ad012c35/`.
Its scrubbed manifest SHA-256 is
`1d26d9f2ae90a665dd89367bf021797708181d7ac1994b68d77c6929a95b40f2`;
the exact source/dependency inventory SHA-256 is
`28528e841fcd3580740c6f3fca9b89cd952382addd99a2a9f215e0a5e916cc99`.
The executed Nix-patched CLI hash is
`00521e695c0bfc8b1bc7ba9b76bb4315b3da37ae43b1738335388d4e4ebf0743`.
It contains verified checksums. An initial
unpatched-CLI launch failed at `native-description` under NixOS and was retained
as a failed receipt. It does not qualify native behavior.

Combined release gates, actual oversized native-context stress, published
consumer graph, Windows fixture qualification and deployment remain coordinator
work. No claim is made that every owner-session recurrence is prevented; unknown
original types and genuinely missing interactions still require supported
recovery. B17 remains a priority until installed qualification proves the fix.
