# 02 — Independent foundation

Contract: one public package, one strict source/test graph, explicit implemented
exports and clean owned emissions. Logical scope keys distinguish the complete
authenticated identity; chosen separators cannot alias a different conversation.

There are no resource/effect owners in this layer. Versioned source is the only
input; a private checkout, installed state and native/provider work are absent.
The module checker rejects imports escaping `src`, deep cross-module imports and
runtime cycles. Later browser exports additionally need an external bundle proof.

The first PR intentionally removed legacy CI/releases and package graphs. This
layer replaces that tooling with checks for the new active graph, rather than
rerunning unrelated protocol-generation compatibility campaigns. No old behavior
test is claimed replaced by the foundation identity check.

Validation: a fresh `git archive` of code/tooling commit
`adac5d6c9035f3f94c5cfd285ca74abb3cfa19d7` installs its own three locked packages
with `npm ci --ignore-scripts --no-audit --no-fund`, then passes `npm run check`:
strict typecheck, source boundaries, one logical identity oracle and clean public
build. Node24.19.0/npm11.17.0; zero native allocations, providers, models or service
actions. The source archive SHA256 is
`019ac65243e3696382d1452e91b8c7ceae77d59768b78f147ba2d5cb7a710579`.
This note records that unchanged code/tooling result; the note itself is amended
after the check. The layer does not qualify an unimplemented Host, browser,
transport or native agent.

## Owner convention amendment

Every authored script is TypeScript (`.ts`) executed by pinned `tsx`; `.tsx` is
reserved for files containing JSX. All CLI
entrypoints use `cmd-ts` with decoding before resource acquisition. Definitions
and help remain inert. ESLint flat configuration uses the recommended JavaScript
and TypeScript correctness rules; Prettier owns formatting (100 columns, standard
2-space/double-quote/semicolon defaults). EditorConfig fixes UTF-8/LF/final newlines.
Generated outputs, installed dependencies, caches and receipts are ignored.
Authored JS/MJS entrypoints are rejected by lint. Control-byte validation regexes
are intentional; optional observer catches remain allowed. Every other exception
is local and explained.

`npm run check` runs formatting, lint, strict types, source boundaries, owner tests
and build. `npm run format` and `npm run lint:fix` are explicit editing commands;
checks never silently rewrite source. Each layer is formatted as it introduces
its files, rather than adding a formatting diff to the final integration. The
actual boundary oracle now follows `.tsx` edges and refuses a real TSX cycle or
missing source; compiled `.js` imports remain the public runtime contract.

## F08 — Actual tRPC boundary

The portable `closeOnAbort` helper binds one actual iterator to its request
signal. Closing seals pending observation promptly while `return()` awaits the
producer's real cleanup; no timer invents retirement. This generic producer
boundary replaces the old JSON-specific Gateway watch wrapper. Imports remain
inert; no model, storage, RPC protocol or recovery owner is introduced.
