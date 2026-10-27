# Installed native compatibility facade

The existing Codex/Copilot validation, selection observation, prepared-input and
native-state helpers moved here from the session primitive. Concrete invocation
implementations live in their corresponding adapter packages. The universal
bounded validation envelopes, opening proofs and session identity remain in the
session primitive.

The invocation helper entry retains `fullStop`, `nativeRun` and
`withManagedDefaults`; it does not forward concrete invocation compilers.
Import those directly from the selected
[Codex](../v8-harness-codex/src/invocation.ts) or
[Copilot](../v8-harness-copilot/src/invocation.ts) adapter. Session's browser entry
exports no concrete native factory or compatibility barrel.

This is an explicit installed facade for the two retained native DTO families,
not a Host registry. Default lifecycle and RuntimeSupervisor require an injected
`NativeProtocol` and never select a kind, apply native setting precedence, or
fall back to a default adapter. Each selected adapter supplies its protocol,
history facet and concrete typed tRPC router. Additional custom Host/router
contracts do not require a central router switch; the default native DTO facade
makes no claim to support a third native family yet.

The focused runner reuses existing validation, invocation and exact native-
resource oracles and adds six plugin-boundary checks. It does not copy or relax
existing tests. An initial new positive Copilot router fixture selected an
unavailable catalog provider and correctly refused before dispatch; the fixture
was corrected to an existing exact model/provider/effort tuple. The next focused
run passed all 51 checks, with zero skipped/cancelled checks and zero native,
model or provider calls. Final composed qualification is separate.
