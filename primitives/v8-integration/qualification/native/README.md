# Bounded native composition runner

This runner is separate from normal qualification. Select a frozen compiled
graph, explicit pinned tools and provider inputs, then obtain fresh finite
native/model authorization before invocation:

```sh
node primitives/v8-integration/qualification/native/run.mjs --allow-native-model-free --frozen-source --tool-root=/path/to/toolroot --config-file=/path/to/provider-config.toml --key-file=/path/to/provider-key --provider=selected-provider --model=selected-model
```

Exactly one profile is admitted: model-free, seed or live-integration. The latter
profiles can forward model requests and require that explicit scope; a flag is
only an execution guard. Optional harness/build-root selection narrows the owned
lane. The runner does not install tools, pull images, import existing sessions
or acquire an ambient native home. There are no personal configuration paths or
provider/model defaults. [run.mjs](run.mjs) and [support.mjs](support.mjs) define
the exact supported flags, tool validation and nonrenewable finite bounds.

## Admission and actual ownership

The source/tool manifest records the actual compiled driver dependency closure,
SDK location, native executable and selected runtime tools. A same-version
package in another tree is not substituted for the dependency actually used.
Scenario admission and provider forwarding spend their respective budgets before
effect. Deadlines include cleanup; another root cannot reset page or request
limits.

Model-free admission refuses upstream requests before construction. A seed/live
profile forwards only the selected exact provider/model after ledger admission.
No synthetic completion, substitute model or credit fallback is supplied. Guard
credentials appear only in disposable homes; real key/config inputs remain
unchanged. Diagnostic capture is bounded, scrubbed and private.

`hosts.mjs` composes real runtime factories, the selected lifecycle, authenticated
HTTP and retained session/history clients from that graph. The model-free seam
can inspect fresh unsent Create, observers, writer evidence, Stop, explicit
sessionless history acquisition and same-ID open-and-wait Resume. A held pre-ID
allocation tests its actual custody fence before native launch; it is not proof
of stopping a hung running CLI.

Only returned owned process/container identities may be inspected or retired.
A stopped controller, idle observation or exited leader cannot replace exact
containment proof. Cleanup keeps actual admitted resources until settlement and
must establish the required absence. A missing boundary produces diagnostic or
partial evidence, not synthetic success.

## Evidence limits

Fresh history can be empty, lack an older cursor or report its journal
unavailable. Such cells remain unexercised/partial with exact scoped evidence;
they cannot establish complete history, Resume or native end-of-history. Native
pages do not settle original Sends, authorize children or answer callbacks.
Fresh unsent no-continuation evidence cannot certify pre-existing pending work.

Receipts include source/compiled/tool hashes, scrubbed observations, admissions,
provider counters, owned absence checks and checksums under ignored artifacts.
A successful envelope performs a final unchanged-source comparison after
cleanup. Failed diagnostics retain their original result. These local artifacts
are not portable public-clone evidence.

This dedicated native HTTP seam does not establish every platform/child/SDK
path, production authentication, publication or installed deployment. It also
cannot identify the initiating physical-close caller in an older unresolved
shared-hop incident. The [source architecture](../../../../docs/design/v8-architecture.md#qualification)
keeps these proof boundaries explicit. No ordinary helper/test implicitly
launches this runner or grants its next allowance.
