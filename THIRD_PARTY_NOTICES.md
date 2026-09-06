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
