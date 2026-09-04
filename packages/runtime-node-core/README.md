# @arduano/agent-multiplex-runtime-node-core

The transport-neutral protocol-v4 runtime-node implementation for Agent
Multiplex. It owns native session bindings, durable command and launch journals,
provider recovery checkpoints, metadata proposals, and optional managed PTYs.

Harness adapters, launch providers, and agent backends are registered
statically. Domain-specific provisioning belongs in a launch provider; native
history remains owned by the selected Codex, Copilot, or other harness adapter.
