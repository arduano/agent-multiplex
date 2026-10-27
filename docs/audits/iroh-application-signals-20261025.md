# Published Iroh application-signal artifact review

The root manifest/lock already selected the published application-signal fork,
but the release helper still required the previous standalone-only Node archive.
The corrected [reviewed closure](../../scripts/release-config.mjs) keeps exact URL,
integrity and transitive-override checks for the selected artifact. The shared
`0.6.2` archive remains unchanged. This review changes no dependency or vendor code.

Both cached published Node archives were read as tar data, verified against their
SHA-512 SRI, and compared member by member on October 25, 2026. Every selected
archive member matches the installed package. No binding was imported, endpoint
created or native/model process started for this review.

| Archive | SHA-256 |
| --- | --- |
| Previous `leo-v6-iroh-0.6.2-d799fa3/iroh-http-node-0.6.2-fork-linux-win-x64.tgz` | `9cf8d5f1a13a7c28e4103f06921badb00b11b76d9287a3b6ecc5f9523d9d2608` |
| Selected `leo-v7-iroh-0.6.2-js-lifecycle-20261022.1/iroh-http-node-0.6.2-fork-application-signals-linux-win-x64.tgz` | `37ffe24076461cb58151a7162f6fe054a439d32e2013a382aa10232407176f12` |

| Selected archive member | SHA-256 | Change from previous archive |
| --- | --- | --- |
| `lib.js` | `78d45b34c3a2c63b0365e5be288ec5e043a811b7f9a9ac8630a686fd34ad022e` | Explicit signal policy and creation/close lifetime fencing |
| `lib.d.ts` | `c2ecda1defa6f9b44454becbd35b807811842016f196b18a7bc0484b8614aeaf` | Signal policy type and function |
| `index.js` | `249e8517affda9dd6f92780ad193f42e94a8d9a1efba9ee13606a74a3d192a67` | Identical native loader |
| `index.d.ts` | `d68ab7f2bb3151701df627bc6384b3934e2945c067e4ccab856c9a6fea5ac2ff` | Identical native API |
| `iroh-http-node.linux-x64-gnu.node` | `3d6739abfd441834d4b58b07738280653c7f70eed3649f842d27a2cfce12c550` | Identical native binary |
| `iroh-http-node.win32-x64-msvc.node` | `22c0dc33aae34fb06af65cd67de3e1f7342543178fb1150512874ec7b6500273` | Identical native binary |
| `package.json` | `ccb23b4d7c10f03e642c59329792bc1c138c1a44467526a83537c3a1192dd35c` | Adds signal-test script; dependencies/license unchanged |
| `README.md` | `d4095c93ac0f298349160063b476cfc36db3656c2c137c5355ee227fce212867` | Documents explicit signal ownership |

The complete JavaScript difference adds
`configureProcessSignalHandling("standalone" | "application")`. Import still
installs standalone SIGTERM/SIGINT handlers. Application mode removes only this
module instance's handlers; its caller owns endpoint closure, other cleanup and
termination. Repeating the selected policy is harmless. A policy change is
refused while endpoint creation, an open endpoint or its explicit native close
is outstanding. Failed explicit close retains that fence. The default standalone
path retains its existing two-second forced-exit behavior.

Creation now tracks the pending native call until settlement. Explicit close
removes its tracked endpoint only after successful native close; the standalone
signal-close path retires tracking after its own settled close attempt before
process termination. These changes transfer no authentication, routing or
native-process authority. Native implementations and shared JavaScript are
unchanged. `SECURITY.md` and `THIRD_PARTY_NOTICES.md` were reviewed; the selected
archive retains the existing MIT OR Apache-2.0 license declaration.

The focused closure test checks the actual root manifest/lock, rejects the old
Node archive, and retains public-registry substitution, transitive-override and
nested-integrity refusal. Byte review does not qualify application signal
shutdown, production networking, Windows execution or native cleanup; those
require their separate finite execution gates.
