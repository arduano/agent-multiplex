# @arduano/agent-multiplex-adapter-codex

The native Codex app-server adapter for Agent Multiplex runtime nodes. It maps
Codex sessions, model and mode changes, prompts, interactions, interrupts,
events, and native history onto the runtime adapter boundary without parsing
Codex history files.

The package pins the Codex CLI version used to generate and qualify its protocol
bindings. Codex app-server transport is upstream-experimental, so deployments
should re-run adapter and live qualification when changing that pin.
