# Protocol-v5 control-tree Docker acceptance

This acceptance starts four isolated containers:

- one durable authority control node;
- one attached branch control node;
- one mock runtime node owned by the branch;
- one zero-authority access gateway connected to both controls.

The driver and browser connect only to the access gateway, never directly to
either control node.

It verifies exact ancestor/descendant source suppression, live command and
native-event routing, loss of the authority process without implicit branch
promotion, warm branch selection, queued metadata while detached from the
authority, authority restart with the same SQLite/endpoint identity, metadata
settlement, deterministic ancestor re-selection, and three browser-visible
states. Raw transport secrets and tickets are scanned out of the receipt.

Run it from the repository root:

```bash
npm run test:docker:v4:tree
```

Receipts are written below `receipts/protocol-v4-control-tree/`. A failed run
is retained with `FAILED.txt`; a successful run contains `summary.json`, RPC
and phase records, redacted container logs, Playwright screenshots, an exact
cleanup receipt, and SHA-256 checksums for every artifact.

The suite targets current protocol-v5 source. Existing command names and receipt
directory paths containing `v4` remain stable; historical receipts retain their
original protocol/source identity and do not qualify v5.

Image acceptance covers multi-chunk upload/read, an exact repeated chunk,
immutable runtime SVG path snapshots, resuming an upload through the selected
warm branch, and reading the same bytes after ancestor recovery. Phase receipts
record descriptors and checksums rather than image byte payloads.
