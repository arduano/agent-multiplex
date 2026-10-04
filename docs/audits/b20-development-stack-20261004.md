# B20 development stack migration — October 4, 2026

Source candidate from framework `c9059f3` retains published `.28` artifact pins,
SDK/CLI/transport pins, all public/durable schemas and release version. It
changes development tooling only. Root owns publication/deployment; no live
Host, session, private credential or service action is part of this qualification.

## Supported exact updates

- Vitest `3.2.7` → **4.1.11** and its lockstep internals fix
  [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
  This maintained fixed major accepts existing Node24 and Vite7. No browser/API
  server or public mocker plugin is enabled. Vitest5 is not needed for this fix.
- Retain the previously isolated, reviewed `fast-uri` **3.1.8** and
  `ip-address` **10.7.3** security patches. They had not been integrated into
  this framework baseline. URI normalization, cross-family subnet exclusion
  and bounded invalid IPv6 diagnostics remain covered by synthetic regressions.
- `http-cache-semantics` **4.3.0** has now been published, fixing
  [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
  It remains within `make-fetch-happen`'s `^4.1.1` range and only reaches
  optional CycloneDX XML/node-gyp tooling. No incompatible internals override
  or removal of optional validation is required. Existing strict script policy,
  including `libxmljs2@0.37.0=false`, stays intact.

Comparison of complete non-development package identity/version/URL/integrity
sets shows **zero runtime additions or removals**. Supported npm deduplication
may move an unchanged package path; that is not a runtime version update.
Fresh full and production audits report **zero vulnerabilities**. Before this
candidate the registry reported four moderate and one high package row. Counts
are time-bound registry evidence, not proof against undisclosed vulnerabilities.

## Meaningful security checks

A synthetic cached response with `Vary: Accept-Encoding, *`, a fixture-only
Set-Cookie and a large client max-stale directive has zero freshness. Upstream
4.2.0 still returns it without revalidation; 4.3.0 rejects it. This negative
control uses independently packed original packages and records no real account,
credential, response or network request. The maintained regression checks both
wildcard orders/multiple fields and confirms ordinary stale public entries still
work, preserving supported caching semantics.

JSON CycloneDX 1.6 generation/schema validation passes with 498 components and
the complete locked graph. XML native installation remains prohibited by the
unchanged policy; a JSON SBOM pass does not claim XML native qualification.

Exact source gates passed: ordinary strict-policy `npm ci --no-audit`, typecheck,
pretest build, full `TMPDIR=/dev/shm npm test -- --maxWorkers=4` (**133 files /
1,343 tests passed**, one file/eight existing skips, 81.60 seconds), checkpoint,
docs/release/secrets and all four security regressions. No assertion or timeout
was weakened. Source tests use disposable tmpfs because NAS private-file fixture
fsync is resource-sensitive; production state is unchanged.

Qualification logs and before/after audits are retained privately in the
consumer's aggregate receipts and local `/tmp/framework-dependencies-*` logs.
The test log SHA-256 is recorded in the consumer result inventory alongside
negative-control/SBOM hashes. Root owns native Windows/toolchain acceptance and
integration with other source lanes; this audit makes no installed claim.
