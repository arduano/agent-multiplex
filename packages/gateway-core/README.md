# @arduano/agent-multiplex-gateway-core

The zero-authority access-gateway core for Agent Multiplex. It validates and
selects projections from one or more control-node sources, suppresses redundant
descendants, routes each action to one owning source, and exposes a synthetic
bounded access feed.

It also provides the restricted launch port used by statically composed gateway
plugins. Gateway plugins are trusted application code, not dynamically loaded
or sandboxed extensions, and cannot become metadata authorities through this
API.
