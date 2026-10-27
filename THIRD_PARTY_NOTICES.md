# Third-party notices

Agent Multiplex is licensed under the MIT License, but that license does not
replace the terms of third-party software, generated declarations, fonts, or
icons used with it. Exact installed versions and transitive packages are
recorded in `package-lock.json`. Consult each installed package and its linked
upstream source for the complete license text; a package archive does not always
embed that text itself.

## Native agent and transport dependencies

- **OpenAI Codex CLI and platform packages** — Apache License 2.0,
  <https://github.com/openai/codex>. The Codex adapter includes TypeScript
  declarations generated from the pinned app-server schema and ships the full
  Apache-2.0 text and upstream NOTICE beside those declarations. OpenAI and
  Codex names and marks remain their owners' property.
- **GitHub Copilot CLI** — the GitHub Copilot CLI License, distributed as
  `LICENSE.md` in `@github/copilot`. It is not MIT. Its current redistribution
  grant is limited to unmodified copies distributed as part of an application
  or service that provides material functionality beyond the CLI, requires the
  CLI license and notices to be retained, and does not grant modification or
  trademark rights. Review the exact installed license before redistribution.
  Use of GitHub services is separately subject to GitHub's applicable terms.
- **GitHub Copilot SDK** — MIT License,
  <https://github.com/github/copilot-sdk>.
- **p2prpc core** — MIT License, copyright 2026 p2prpc contributors,
  <https://github.com/arduano/p2prpc>. The default dependency is its exact
  published package; transport development and qualification also records the
  corresponding sibling source revision and artifact digest.
- **node-pty** — MIT License, including notices for Christopher Jeffrey, Daniel
  Imms, Microsoft Corporation, and contributors,
  <https://github.com/microsoft/node-pty>.

Native Copilot task observation and control call the existing pinned SDK APIs.
They use the already locked MIT-licensed Zod validation library and add no new
third-party package, copied vendor source, bundled executable or process-control
library. The SDK and CLI terms above continue to apply to those components.

Native context compaction uses the existing pinned Codex app-server and Copilot
SDK interfaces, including the already generated Codex declarations and locked
Zod validator. It adds no third-party dependency or copied vendor implementation.
The native components retain their terms above.

Authenticated renewal uses the independently published MIT-licensed
`@arduano/p2prpc-core@0.3.0-renewal.1` from exact source commit
`97161e1bd44dbe30ba957092bc82ebf707716fd9`. Its license and notices remain
in the package; the framework manifest and lockfile pin its registry integrity.
The temporary local source patch and injection scripts were removed. See the
[design/migration](docs/design/p2prpc-renewal-vnext.md).

## Web client code and assets

The built dashboard includes declared packages and assets including:

- React, React DOM, Radix UI, TanStack Query, xterm.js, React Markdown,
  react-resizable-panels, Tailwind CSS, and related libraries under their
  respective MIT licenses;
- Lucide icons under the ISC License, with certain Feather-derived icons under
  the MIT License, <https://github.com/lucide-icons/lucide>;
- Geist and Geist Mono font software under the SIL Open Font License 1.1,
  copyright the Geist Project authors, <https://github.com/vercel/geist-font>.

The SIL Open Font License continues to govern the font software embedded in the
web output. Neither the font software nor an individual component may be sold by
itself, and reserved font-name and attribution conditions continue to apply.
The web package ships `THIRD_PARTY_LICENSES.txt`, generated from the exact
compiled JavaScript source maps plus the explicitly embedded CSS/Geist inputs. It
contains every discovered component identity and the complete corresponding
upstream license/copyright documents; the release gate rejects a stale copy.

## V8 chat code and font assets

The continuous document viewer uses the exact published MIT-licensed
`@tanstack/react-virtual` 3.14.10 and its locked `@tanstack/virtual-core`
dependency. The existing build derives their license entries from the actual
bundle inputs and emits their full upstream license text with the artifact.

The isolated V8 React chat has its own exact dependency lock under
`primitives/v8-react-ui`. Its build-time notice companion uses actual JavaScript
and CSS input graphs, including the fixed Mermaid renderer, rather than assuming
the parent dashboard's dependency closure. Mermaid/KaTeX/math plugins add MIT,
ISC, BSD, Apache and other declared components. The bundled `elkjs@0.9.3` layout
engine is EPL-2.0; the companion includes its complete license and source
availability locator. DOMPurify uses its Apache-2.0 alternative. KaTeX's emitted
font software retains separate SIL OFL 1.1 copyright/Reserved Font Name records,
alongside its MIT JavaScript license. Distribute `THIRD_PARTY_LICENSES.txt` and
`THIRD_PARTY_COMPONENTS.json` with the emitted chat/renderer/font assets. A
consumer's bundled React/fonts and other inputs remain part of its own companion.

The passive document preview pins `pdfjs-dist@6.3.289` (Apache-2.0). The build
emits its exact worker, Adobe CMaps and standard font files without the scripting
sandbox runtime. The package's own font/CMap license documents are included in
the generated companion and beside their unmodified emitted assets. These font
terms are independent of the PDF.js JavaScript license.

## Build and test dependencies

The lockfile also contains build and test tools under MIT, Apache-2.0,
MPL-2.0, ISC, BSD, 0BSD, CC-BY-4.0, and other declared licenses. Development
dependencies are not intentionally included in runtime packages, but their
licenses still apply wherever a release pipeline redistributes them or their
assets.

Windows private-state validation invokes the operating system's installed
Windows PowerShell and .NET ACL APIs. No PowerShell binary or additional npm
security/native dependency is bundled by this change; operating-system terms
continue to govern those installed components.

Before publishing a binary, container, web bundle, or npm package, generate an
SBOM from the exact lockfile/artifact, inspect every `UNKNOWN` or custom license,
and ship all license/NOTICE files required by that artifact. This summary is a
navigation aid, not a substitute for the full upstream licenses or legal review.


## Image transport and rendering review

The v5 image feature uses existing Node filesystem/crypto APIs, the already
included `@noble/hashes` client dependency, and browser Blob/image rendering. It
adds no SVG renderer, converter, image codec package, or external image-fetch
service. Runtime code preserves image bytes. Native vendor image data and
user-supplied images retain their owners' applicable terms; the project's MIT
license does not relicense those contents. Regenerate the web license inventory
and SBOM from the exact release artifact as usual.


Storage-worker isolation uses built-in Node worker_threads, perf_hooks and v8
APIs plus the existing SQLite/tRPC dependencies. It adds no third-party package,
vendor code, filesystem driver or bundled supervisor executable.

The lifecycle command-error contract uses the existing locked Zod and UUID
packages. Its fixed public messages and SQLite migrations add no third-party
dependency or copied vendor implementation.
