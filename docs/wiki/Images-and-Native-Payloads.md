# Images and native payloads

Protocol v5 supports images in native Codex/Copilot messages and runtime output.
Use the browser-safe client helpers `imageTarget`, `uploadImage`, `imageMessage`,
and `readImage`; their contracts are in
[`packages/client/src/images.ts`](../../packages/client/src/images.ts).
The current development/release split is recorded in [current state](Current-State.md).

## Sending and displaying images

Upload under the current session/runtime/binding/boot fence, then pass the
returned descriptors into `imageMessage` and the ordinary retry-stable command
builder. Uploading needs `agent-control`. Image-only messages are valid; model
support and limits come from each harness's native model discovery. A missing
vision capability is unknown, not proof of support.

Reading an image or resolving a runtime Markdown path needs `read`. Clients
verify the descriptor, chunk offsets, byte length, and SHA-256 before display.
External URLs are links by default; runtime image APIs never fetch them.
Runtime output SVG remains SVG bytes throughout transfer and is rendered in an
image context without injecting markup. When a user selects an SVG attachment,
the reference browser composer converts it to PNG locally before upload, with
at most 4,096 pixels on the longest side and the ordinary byte-size limit. Core
never renders or converts SVG; custom clients own interpretation and any input
conversion required by their selected harness.

Native history, events, results, and interactions now carry a
`native-json-images-v1` envelope. Read native fields from `.json`, and handle the
`.images` sidecar at its exact JSON pointers. Unavailable slots are explicit.
Commands and native envelopes each have a 960 KiB budget covering JSON and
conservative binary encoding size. Native history pages honor this same budget,
including image descriptors and retained representation metadata.
Use `reconstructNativePayload` only when a consumer actually needs the original
native binary representation; ordinary transcript rendering can retain refs.

## Storage and paths

The runtime accepts PNG, JPEG, WebP, GIF, and SVG, with 256 KiB chunks, 10 MiB
per image, and at most 10 references per command. Query `images.limits` for
storage limits and honor any narrower model limits. Runtime command dispatch and the reference composer also cap one message's
selected image bytes at 50 MiB.

Committed images and first-display path snapshots survive stop/resume and
restart until archive. Exact upload retries reuse the same image ID and bytes.
Aborting removes only unfinished uploads, which expire after 24 hours by default.
Archive releases the retained bytes. Missing native output is shown as unavailable
rather than recovered from terminal scrollback or vendor history files.

The direct runtime reads only the session workspace plus explicitly configured
image output roots. Relative paths resolve against the bound session workspace;
absolute paths undergo the same confinement checks. Missing workspace roots,
symlink escapes, and remote URL schemes are rejected. It does not grant image
reads across every allowed launch root. Runtime app configuration supports:

- `AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_OUTPUT_ROOTS`: JSON array of additional image roots;
- `AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_SESSION_BYTES`: per-session quota, default 512 MiB;
- `AGENT_MULTIPLEX_RUNTIME_NODE_IMAGE_RUNTIME_BYTES`: total quota, default 10 GiB.

The app stores private bytes under `<stateDirectory>/images`. Embedders can set
`RuntimeImageOptions.directory`; otherwise a file-backed store uses
`<sqlite filename>.images`. Custom filesystem backends must provide a bounded,
confined `readImageFile` implementation.

See [backup and upgrade guidance](Backups-Upgrades-and-Recovery.md) before
moving a runtime. The full routing, retention, and migration contract is in
[the v5 image design](../design/images-v5.md).

The reference runtime accepts `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES`
as a JSON map from model ID to native Copilot `supports` and `limits` objects.
Use this when a BYOK provider does not advertise its own image capabilities.
The UI uses the applied model's vision support, image count, media types, and byte
limits; unreported capability remains visible as unknown. Configuration contains
capability facts only; provider credentials remain in their existing secret files.

## Verification

The deterministic Docker tree suite covers routed transfers, immutable path
snapshots, failover, CLI image-only input, and browser previews, attachments,
reload, responsive layouts, and accessibility. Run the ordinary repository gates
before retaining an exact-source receipt.

After building, `node --import tsx scripts/qualify-copilot-offline-images.mjs`
exercises the pinned native Copilot runtime against a loopback completion fixture.
It checks user attachments, `model.messages_snapshot` image externalization, and
native/resumed history without external model calls. It writes scrubbed,
checksummed local evidence, and does not qualify a model's vision accuracy.
Real model qualification remains a separately authorized run; current evidence
and its limits belong to [the checkpoint](../checkpoint-v4.md).
