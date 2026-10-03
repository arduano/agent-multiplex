# B20 narrow development dependency maintenance — October 3, 2026

Isolated candidate based on published `.27` source
`1d5b980c653f8ec870a16dec9162cca9491c03c9`. No runtime dependency, published
package/version, SDK/CLI/transport, schema or installed role changes.

## Exact fixes and qualification

- Pin development-only `fast-uri` from `3.1.7` to `3.1.8`, fixing
  [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj).
  It is reached through optional CycloneDX AJV validation. `^3.0.1` remains
  compatible; no optional package is added or removed.
- Pin development-only `ip-address` from `10.7.0` to `10.7.3`, fixing
  [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)
  and [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw).
  It is reached through optional libxmljs2/node-gyp/SOCKS tooling. The existing
  `^10.1.1` range remains compatible. Native script policy is unchanged.

Three focused `node --test tests/dependency-security.test.mjs` regressions
pass with Node `24.19.0`/npm `11.17.0`, zero skips. They exercise mixed-case
percent-encoded generic URI hosts, cross-family subnet rejection with valid
same-family controls, and bounded invalid-IPv6 diagnostics. Published old
artifacts independently show `custom://%45XAMPLE.com` normalizing to
`custom://Example.com`, `::1` admitted into IPv4 `0.0.0.0/0`, and a
100,000-character invalid input creating 100,022/100,033-character diagnostics.
The fixed graph rejects those conditions.

CycloneDX 1.6 reproducible JSON generation and schema validation passed with
506 components, including exact `fast-uri@3.1.8` and `ip-address@10.7.3`.
Release metadata, documentation and secret checks pass. An initial checkpoint
check was run before build and failed on missing `dist/index.js`; preserve this
pre-build diagnostic, then run the ordinary checkpoint gate after building.
This is development tooling compatibility evidence; package publication and
installed activation are separate.

## Fresh audit and safe deferrals

Full lock audit: **four moderate/six high rows before → two moderate/six high
after**. Production (`--omit=dev`) reports zero vulnerabilities. Excluding
optional tooling yields two moderate/zero high rows. Counts are package rows,
not distinct vulnerabilities; old release counts are historical.

Vitest/`@vitest/mocker` remain on exact `3.2.7`. Their two moderate rows refer
to one [redirect mock advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
fixed in `4.1.11` with no planned 3.x backport. Current `vitest run` configuration
does not expose public mockerPlugin/interceptorPlugin registration, browser
RPC, API mode or a remote test server; separate Playwright fixtures do not use
those mocker exports. Preserve that usage restriction. Do not mix newer mocker
internals into Vitest 3 or make a broad test-stack migration in this patch.

Six high rows now derive from one newly reported optional
`http-cache-semantics@4.2.0` [cache disclosure advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp),
propagated through `make-fetch-happen`, `node-gyp`, `libxmljs2` and CycloneDX.
The npm registry still reports latest `4.2.0`; proposed `4.2.1` returns `E404`.
There is no released patch to pin. The chain is optional build/SBOM tooling,
absent from runtime dependency paths. `allowScripts.libxmljs2@0.37.0=false`
remains enforced, and the successful JSON SBOM used no new native/XML path.
Retain the advisory; the **full high audit threshold does not pass**. Upstream
patch or independently reviewed optional XML-tooling removal remains follow-up
work. Do not downgrade CycloneDX merely to suppress the audit, or claim an
`--omit=optional` audit changed the release installation procedure.

SECURITY.md and THIRD_PARTY_NOTICES.md were reviewed. The patches remain under
existing MIT package licenses and alter no security-role boundary, deployed
policy, runtime code or notices shipped in web bundles.

## Local receipt identities

Ignored `receipts/b20-dependencies-20261003/` contains:

| File | SHA-256 |
| --- | --- |
| `focused-security.txt` | `10f94ff41fc16e398fdd807248761db80df34a7b72091583e683d09d69406c88` |
| `old-artifact-negative-controls.json` | `7e8517363e12f90e864ce8de0fee76bdb17668f114bf1b63bd53077ced87683b` |
| `sbom.cdx.json` | `b560c54c687b251c5b98b51790120bb6a2663e56cc21222606096829b38c43fd` |
| `framework-b20-audit-after-20261003.json` | `24039a59805a8c6b8d03fbd57fcb9ec227b5dc470c8e596f604959a67cad1edd` |
| `framework-b20-audit-prod-after-20261003.json` | `4388721caf5a137dd5055993f933a1613a8b822ac97007634c0fc809c0f24ea1` |
| `framework-b20-audit-no-optional-after-20261003.json` | `91a345168e45417026a492636d947c1200452e51da1d5814246a211bb583a0ae` |
