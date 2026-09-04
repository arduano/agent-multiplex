# @arduano/agent-multiplex-protocol

Protocol-v4 wire schemas, identifiers, and tRPC-compatible contracts for Agent
Multiplex. This package defines the public access surface and the internal
control-node/runtime-node link surfaces without selecting a transport or owning
runtime state.

Metadata is a flat namespaced JSON key/value document. Harness-native events,
commands, interactions, modes, and history payloads remain native rather than
being flattened into a synthetic conversation format.

Consumers normally use this package for schemas and exported TypeScript types,
then choose an HTTP/WebSocket or p2prpc client package for transport.
