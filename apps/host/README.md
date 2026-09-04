# Archived protocol-v2 host

This directory is retained only as historical design/implementation evidence.
It is not an npm workspace, TypeScript project reference, test target, Docker
input, or protocol-v3 compatibility layer. Its old manifest references the
removed `@agent-multiplex/worker-core` package and is intentionally not
buildable in the current tree.

The maintained replacement is `apps/control-node`; see
[`../../docs/checkpoint-v3.md`](../../docs/checkpoint-v3.md). Do not import or
repair this directory during protocol-v3 work.
