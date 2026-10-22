# V8 clean break owner lane

The owner explicitly requested a new full rewrite to preserve useful Multiplex
capabilities while reducing defect surface, redundant tests and coupling.

This worktree is `/home/arduano/programming/multiplex-v8-20261022/agent-multiplex`,
branch `rewrite/v8-clean-break-20261022`, based on exact published framework `.44`
commit `ecb4e1b2c85b1ee80f5e9e275c04ac4287fcd420`. The matching application
worktree is `/home/arduano/programming/multiplex-v8-20261022/leo-multiplex`,
which includes the current working-source overlay rather than stale HEAD alone.
One durable Multiplex V8 owner agent owns both isolated worktrees.

Read AGENTS.md, leading Current-State.md and the full V8 owner brief at
`/home/arduano/programming/multiplex-v8-20261022/leo-multiplex/docs/V8-Rewrite-Handoff-20261022.md`.
Historical V5/V6/V7 generation/layout proposals do not veto the owner's V8 clean
break. Retain native ownership, private state, explicit effect certainty and
published dependency/process policies while deliberately redesigning V8.

First produce the feature/test/state-ownership map and a small architectural
decision, then implement an isolated mocked/scripted vertical slice. Reduce
redundant mechanisms and tests through explicit invariants and unique oracles.
Do not inherit V7 topology or file structure by accident. p2prpc/Iroh remain
published pinned dependencies unless a specific isolated change is justified.

Existing source trees and all installed roles/native sessions/providers remain
untouched. No production deployment, native-state import, VM task mutation or
live/model qualification campaign belongs to this bootstrap. Fresh model-test
calls require a separate bounded owner allowance. The existing V7 maintenance
agent and VM Orchestrator retain their independent responsibilities.
