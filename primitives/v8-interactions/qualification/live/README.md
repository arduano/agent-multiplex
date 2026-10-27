# Finite native interaction qualification

The runner is opt-in and never launched by ordinary tests. It requires fresh
finite authorization, explicit pinned tools/provider inputs and disposable
native state:

```sh
node qualification/live/run.mjs --allow-live --tool-root=/path/to/toolroot --config-file=/path/to/provider-config.toml --key-file=/path/to/provider-key --provider=selected-provider --model=selected-model
```

There is no personal configuration path, provider or model default. Invocation
flags do not themselves grant an allowance. The selected ledger fixes scenario,
root/child, actual provider-request and wall-clock bounds. Narrowing flags reduce
scope. Resuming an existing ledger cannot replay admitted originals, renew its
deadline or silently replenish budgets. Source [run.mjs](run.mjs) defines the
actual flags and bounds.

## Native seam

Requests pass through the actual InteractionOwner, selected lifecycle's SQLite
original receipts, retained clients, authenticated HTTP and a Chromium response
fixture. Optional local MCP fixtures use actual native protocol paths; injected
callbacks or model text cannot prove native approval/settlement. Submission,
native reply and independently observed tool outcome remain separate evidence.
Unavailable or unobserved variants stay explicit rather than being reconstructed
from idle/history.

The provider guard admits actual forwarding before effect, keeps credentials in
memory and rejects fallback models/routes. Disposable native homes contain only
a guard credential. Confirmation/permission policies belong to the selected
fixture; restricted scenarios cannot change ordinary trusted defaults or
pre-existing enabled MCP settings. Only newly owned resources can be stopped.

## Offline checks and evidence

The [preflight oracles](preflight.test.mjs) use scripted callbacks, mock upstream
and real Chromium/HTTP. They check admission/model traps and browser response
handling without native-agent/model calls. Captured ingress regressions preserve
optional-field omission, literal native permission entries and exact namespaced
MCP identity without relaxing unrelated validation.

Ignored `artifacts/` output records source/tool hashes, original admissions,
scrubbed bounded observations, results, cleanup and checksums. Failed envelopes
remain diagnostic. Local private native state is not portable public evidence;
only reviewed minimized regression fixtures belong in tracked source.

A passing native subset does not imply every permission/question/form path,
all SDK callback completion, production sign-in, installed fleet behavior or
unrelated transport acceptance. The [generic architecture](../../../../docs/design/v8-architecture.md#interactions-and-mcp)
keeps native prompt, original receipt and observer ownership separate. Another
native/model invocation needs new explicit finite scope, never inference from a
historical receipt or this README.
