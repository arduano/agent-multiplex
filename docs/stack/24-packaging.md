# 24 — Immutable public Nix payload

This layer packages Agent Multiplex and its reference application. The payload
contains code, public pinned dependencies and a Node launcher. Agent/session
data and machine credentials/pairing remain external, independently owned roots.
Building it neither creates a session nor installs or selects a service/profile.
An application may atomically select the resulting store payload through its
own installation owner.

## Standard dependency/build contract

The only flake input remains public nixpkgs revision
`d6524aaca2ff07876657ae2b323f24be4874944b`, locked to
`sha256-2V9GZGvPfrNzxFozhI9dcqV+c3QdA8YZrvAAzqEB+dI=`. There are no private
repositories, sibling checkouts, credentials, topology or local package inputs.
This package supports x86_64-linux and asserts Node24.19.0 for build and runtime.

`buildNpmPackage` and `importNpmLock.npmConfigHook` now own npm installation,
build, pack and production pruning. `importNpmLock` fetches the committed lock's
HTTPS artifacts with their SRI hashes; it needs no second aggregate lock hash.
All materialized lock entries must be published HTTPS/SRI artifacts. Local,
linked, git or missing-integrity entries are refused before the import/build
ports run. Direct dependencies must declare exact versions matching their lock
entries, or the same locked HTTPS release URL. This prevents an original
runtime manifest from retaining an implicit file/workspace dependency.

The standard import hook rewrites dependency locations only for its offline
installation. It saves and restores the original package.json/package-lock.json
before the named build and packing steps. Original public metadata therefore
reaches the package. The framework has no custom archive manifest, bootstrap
extractor, package walk, platform selector or alternative npm resolver.

One shared npm flag, `--ignore-scripts`, applies to install, rebuild, explicit
build, pack and prune. The explicitly requested build command runs; implicit
dependency lifecycle and pre/post scripts do not. Installation and production
pruning include compatible optional packages, preserving required native platform
bindings such as Blake. Dev classification and platform selection belong to the
normal npm lock implementation. Incompatible optional artifacts may be fetched
as fixed build inputs while npm selects the active platform; fetching an archive
does not execute its contents.

The pinned upstream hooks can be reviewed directly:

- [import hook](https://github.com/NixOS/nixpkgs/blob/d6524aaca2ff07876657ae2b323f24be4874944b/pkgs/build-support/node/import-npm-lock/hooks/npm-config-hook.sh)
- [build hook](https://github.com/NixOS/nixpkgs/blob/d6524aaca2ff07876657ae2b323f24be4874944b/pkgs/build-support/node/build-npm-package/hooks/npm-build-hook.sh)
- [install/pack/prune hook](https://github.com/NixOS/nixpkgs/blob/d6524aaca2ff07876657ae2b323f24be4874944b/pkgs/build-support/node/build-npm-package/hooks/npm-install-hook.sh)

The full pinned Node package supplies npm while building. The final multiplex
wrapper invokes pinned Node24.19.0 slim directly on dist/reference/cli.js. cmd-ts
and tsx are declared runtime dependencies because the CLI parses its real command
contract and explicitly loads application TypeScript through tsx's public API.
No global loader, provider installation, private native home or process search
supplies these dependencies.

## Source and payload boundaries

`nix/source-filter.nix` is the actual build-source allowlist. It admits src,
package/lock, tsconfig.json, LICENSE, README and scripts/build.ts. Symlinks are
excluded. Root tests, tooling configuration, arbitrary operator scripts, caches,
generated output, node_modules, private homes, credentials and mutable state
files are excluded. Public source remains responsible for keeping secrets out of
src and public metadata; this filter does not turn committed source into private
configuration.

The resulting layout is:

```text
$out/bin/multiplex
$out/lib/node_modules/@arduano/agent-multiplex/
  package.json
  LICENSE
  README.md
  dist/
  node_modules/       # npm's selected production dependency closure
```

Normal package packing honors the declared public file list. No test tree,
source checkout, credentials or mutable agent/system directory belongs in that
runtime root. The output is a payload, with no service unit or deployment action.
The public launcher still requires explicit application and separate agent/system
paths for real use. Its model-free demo owns disposable state and is a separate
explicit operation.

autoPatchelfHook resolves the actual Linux ELF dependencies after installation.
The compiler runtime, musl and ncurses are available: published Koffi includes a
musl addon and Codex includes zsh/tinfo. There is no unresolved-library ignore
list. Actual Codex/Copilot CLI, SDK, Iroh and Blake layouts must be inspected in
the final payload; successful npm installation alone does not qualify them.
The JS Codex launcher requires its matching native platform package. Copilot's
SDK version assertion does not replace its separately pinned CLI artifact.

## Focused checks and test retirement

The custom scripts/nix-dependencies.mjs source is retired. Converting it into a
tsx CLI would require the very dependency tree it was intended to bootstrap.
Using the pinned standard Nix/npm primitives removes that circular bootstrap and
the framework's bespoke extraction surface.

Three earlier helper-specific oracles are retired with their implementation:

- Hoisted/nested runtime extraction and inert package scripts: the hand-written
  extraction/selection algorithm no longer exists. The actual final Nix payload
  and its inert entry-point checks must qualify the standard dependency closure.
- Traversal/archive-link/parent-symlink rejection: there is no framework archive
  input CLI or extraction loop. Fixed-hash acquisition and unpacking are owned by
  pinned Nix/npm tooling, rather than a second parser requiring framework tests.
- Duplicate/non-materialized extraction manifests: that generated manifest and
  public input format no longer exist. Actual package admission instead refuses
  non-published/local/linked/unhashed dependency sources before its build ports.

The retained source-filter oracle evaluates the actual Nix function. A second
oracle evaluates the actual package expression with inert constructor ports: a
published pinned fixture is admitted, while missing integrity, HTTP, local, git,
linked and original local-dependency declarations are refused without fetching
or building. Neither test mirrors shell text or asserts formatting. Missing Nix
is an explicit skip only for ENOENT; evaluation errors and timeout remain failures.
Both evaluations have bounded calls and disposable fixture cleanup.

Focused amended-source checks passed: Nix syntax parsing, strict TypeScript
checking, and both actual-expression/filter tests in9.11s. A selected isolated
source copy evaluated to a derivation in7.03s, without fetching/building the
payload. Its exact package/lock/Nix hashes and cleanup receipt are retained in
`.cache/packaging-standard-eval.json`. That copy's source is not the coordinator's
final frozen build input.

## Previous convention checkpoint: standard-hook payload

The coordinator froze source, formatting and lock at
`d65e444b60bc0fbb05d82a640c03c664638ea6cd`. A clean external git archive of that
commit, without checkout dependencies/caches, passed the actual standard-hook
evaluation and first full build. The archive SHA256 is
`c98328801cf4e87707a01100128cf72654dac7283b4a6714b5e407301db0a65c`.
The manifest SHA256 is
`2de3d55c7e6fa76ec97bfde4d9c59c5e15ff27d482bab05623a0497d97551136`;
lock SHA256 is
`6558b8b915e88f9a21e6576def58ffbd33b3a4e6e749f311a233942d3535a59e`.
The build completed in218s, with no source fix or retry and zero unresolved
autoPatchelf dependencies.

The resulting immutable artifact is:

`/nix/store/x0p4rk2yp4yq9jfr2y6acza5bpc9ghzk-agent-multiplex-0.8.0-alpha.0`

Its NAR hash is `sha256-ntMV4+uZgzatbztbkABu+7vZmnLbiWPp86KWX1pRyIQ=`;
NAR size896963640bytes. The closure has64paths and1167021728bytes; the SHA256
of its sorted path list is
`3d700ca733024112f6023e377a9bb87683e783466f802be333ec4c380b7b41e3`.

Installed-payload checks passed:

- All40 JavaScript public entry points import under the installed pinned slim
  Node, with zero monitored child processes, requests or listeners during import.
- Actual installed Iroh and Blake native bindings load. The known empty BLAKE3
  digest matches. Actual Codex/Copilot CLI, Koffi, Iroh, Blake and esbuild ELF
  metadata was read, without invoking vendor CLIs or endpoint factories.
- Installed CLI help runs with empty private HOME/PATH and leaves that home
  empty. The CLI also loads an explicit .tsx application containing actual JSX
  using installed tsx4.23.15/esbuild0.28.2. Its create sentinel observes the exact
  separate agent/system paths, then intentionally exits1 before any listener.
- All183 selected production package instances match the frozen lock's versions;
  no entry marked dev:true remains. Production follows lock classification:
  TypeScript's required peer and the explicitly needed tsx/esbuild are retained.
- Public package.json is byte-identical to frozen source. All183 selected hidden
  runtime-lock version/resolved/integrity records match the original lock,
  including the three pinned transport release URLs. No rewritten file/store
  dependency locations remain there. The root package-lock is intentionally
  omitted by the declared public file list.
- Runtime root contains only LICENSE, README, dist, node_modules and package.json.
  UI HTML/JavaScript/CSS exist. Framework output/launcher scanning found no
  development checkout, external qualification copy or filtered build-source
  path. Third-party packages retain their own published layouts.

Exact input hashes, build/evaluation logs, artifact/closure metadata, ELF records,
runtime imports, manifest/lock checks and sentinel receipts are retained under
`.cache/packaging-standard-final/d65e444b/`. Every qualifier caller exited. The
owned external source/archive, private home, agent/system paths and transpiler
cache were removed and ENOENT verified; the private home was observed empty
before removal. No vendor CLI, native agent, model/provider, endpoint, deployment,
profile selection or service change occurred. Documentation-only amendments to
this note are not new build claims.

The earlier custom-extractor r3 build remains a historical artifact at
`/nix/store/n2fpdcgx7gcm17ighyg2v4i74irpqbwl-agent-multiplex-0.8.0-alpha.0`, with
receipts under `.cache/packaging-pr20/full-r3/`. Its successful build, native
imports and closure measurements belong to that earlier implementation and
source. They are not qualification evidence for this standard-hook replacement.
Existing artifacts, profiles, services, agent histories and credentials remain
untouched by this source change.

## Current owner-review payload F01–F06

The new233path source seal includes the `.ts` build entry, portable journal
contracts, Zod forms, actual tRPC adapters and explicit runtime-role folders.
A separate clean archive of `a9df79c92f96a465c0440faf75e51ae4487b7116` (archive
SHA256 `a530096960cef386ac37d4a9bc11ccf7e4205af8569aaf5fea2a7ca5b61b07a3`)
passed the one actual standard-hook build in298.999s. Installed inspection and
owned cleanup completed within366.678s total. No build retry was needed.

Artifact: `/nix/store/jy8y4pq5bbic2rk9hbj3md20dnzv4qgv-agent-multiplex-0.8.0-alpha.0`.
NAR: `sha256-2izVjD6EDeBchZH0RVY37RKJzHtG9I+MGaS5GjTt+6o=`,897030224bytes.
Its64path closure is1167088312bytes; sorted-path SHA256
`ce584b1aef346146e9bd2ddd2c97cba31409a0937d27db444634269bfeecfd84`.

All41public JS exports import inertly under pinned slim Node24.19.0, with
zero monitored child/request/listener/socket effects. Actual Iroh and Blake
bindings load and the known BLAKE3 digest matches. All183production package
instances match original version/resolved/integrity fields; no dev entries,
EventSource or parser remain. The public manifest is byte-identical to source.
Empty-HOME/PATH CLI help and explicit actual-JSX TSX application loading pass;
the sentinel exits before any listener. All46ELF metadata records are retained,
autoPatchelf reports zero unresolved dependencies and source-path scans are clean.

The separate owned source/dependency/private-state scratch root was removed and
its absence verified; all qualifier callers were reaped. No vendor CLI, native
agent, model/provider, endpoint, service or profile was invoked or changed.
`.cache/review-f01-f06/nix/qualification.json` retains the exact inputs and detailed
receipts. Later documentation-only amendments do not create a different NAR claim.

## F07 scope

Contract-first source/declaration/package exports are qualified by the new
independent consumer and production browser. Nix/flake/standard-hook inputs and
production dependency pins are unchanged. No fresh installed NAR is claimed:
all artifact identities above retain their historical source. The F07 source
seal and final acceptance distinguish those scopes explicitly.

## F09 published bridge closure: build attempted, artifact unqualified

The current package/lock pins published p2prpc0.3.1 over HTTPS/SRI, including the
portable file entry. The independently installed tarball proves its actual public
entry/binding closure; it does not qualify a Nix payload.

One actual Nix build of exact sourcefc31bac29ee4aab80a71db809e3e3a1f28c49897
failed after124.05s. `scripts/build.ts` killed TypeScript at its inner60-second
`execFileSync` limit (`ETIMEDOUT`/`SIGKILL`); the outer720-second allowance was
not reached. No TypeScript diagnostic or OOM evidence was captured. The compiler
outcome beyond that deadline is unknown. There is no new qualified NAR or installed
inspection. Build-budget ownership is a recorded hardening follow-up, not a reason
to inherit the historical Nix artifacts above. [Evidence.json](Evidence.json)
records this failed attempt separately from passing source/package/browser checks.
