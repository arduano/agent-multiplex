# @arduano/agent-multiplex-control-node-core

The transport-neutral protocol-v4 control-node implementation for Agent
Multiplex. It owns canonical session catalog state and metadata, composes strict
control-node trees, routes operations to runtime nodes, and exposes bounded hot
feeds and cold session search.

The package deliberately does not host native agents or HTTP/p2prpc listeners.
Applications provide authenticated child and runtime connections and pair the
service with a durable store.
