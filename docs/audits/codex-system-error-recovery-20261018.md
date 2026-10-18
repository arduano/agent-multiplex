# Codex failed-idle recovery correction - October 18

Tariff's latest native turn failed with provider-bridge HTTP 502
`upstream_network_error`. Bounded native reads report `systemError`, no active
turn and no exposed questions. The existing adapter accepts only idle or
explicitly empty active flags as complete interaction baselines. Reattachment
therefore repeats incomplete hydration and prevents the next user message.

Native [thread status source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/thread_status.rs)
clears running and pending-input flags for a system error. Status selection
prefers active work/requests over that error, and a subsequent turn clears it.
The repair includes this known inactive status in baseline completeness while
requiring zero adapter-owned pending requests. Runtime errors stay visible;
Host event-gap and expired-mutation fences are unchanged.

Candidate `.43` keeps all 17 workspace versions/internal pins coherent. Native
CLI/SDK, independent transport, wire schemas, SQLite schemas and provider policy
remain unchanged. Disposable synthetic JSON-RPC/Host regressions exercise failed
resume, live status transitions and genuine uncertainty. Qualification results
are recorded separately after execution. No model call or production-state
fixture is required. Installed Windows acceptance is a consumer operation and
is not established by source tests or artifact publication.
