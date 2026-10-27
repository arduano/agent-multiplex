# Rich chat rendering

`ChatMarkdown` is presentation only. Native normalization, history ownership,
file authorization and original requests stay with the existing retained clients.
It renders GFM, bounded KaTeX math and fenced Mermaid. Raw HTML is disabled;
Markdown images never request arbitrary URLs. `onLocalFile` is an optional intent
callback for a consumer that already owns the authenticated file reader. It
grants no filesystem access.

Mermaid runs in a fresh, opaque `sandbox="allow-scripts"` iframe. The parent
fetches only the consumer's fixed, same-origin renderer asset with no redirect;
diagram text travels afterward through a source-checked, request-ID-checked
message. The iframe CSP denies network, external images, other frames and form
submission. It returns bounded sanitized SVG, which the parent displays only as
an inert Blob image. Raw SVG never becomes application DOM. Completed/aborted
frames and Blob URLs are released on source change or unmount.

The build emits `index.js`, `chat.css`, `fonts/` and
`renderers/mermaid-frame.js`. Include all these assets. The default renderer URL
is relative to the bundled UI entry; a consumer that combines that entry into
another bundle supplies its own trusted `assets.diagramRendererUrl`. It must
point to the emitted renderer on the same browser origin. Never derive it from
chat content or a session file. The embedding CSP must allow this sandboxed frame
and Blob image display. The module adds no service worker or page ownership.
For a nonce-restricted parent CSP, pass the actual per-response script nonce as
`assets.cspNonce`. A `srcdoc` inherits its parent's policy, so an unrelated
generated nonce cannot authorize its fixed packaged script. The renderer never
weakens that policy; without a usable nonce it retains a readable source/error.

The bundled stylesheet prefixes KaTeX selectors with `.multiplex-chat`; font
faces are ordinary named font resources. `markdown.css` contains only renderer
additions and is not a substitute for the complete built `chat.css`.

Incomplete or actively streaming Mermaid fences remain source text. A render
failure, timeout, unavailable asset or four-render capacity limit leaves the
source readable and exposes a deliberate Retry. Input, statement, edge, output,
element and pixel bounds contain layout work; there is no persistent queue,
retry timer or cross-session Mermaid cache. Math retains TeX source for malformed,
oversized or extreme-layout expressions. Fenced tool/code examples stay literal.

Markdown and its custom element components retain stable React identities.
Viewport/geometry notifications cannot replace an in-flight diagram or reparse
an unchanged message. The browser oracle covers this through the actual retained
workspace and iframe rather than testing a separate rendering simulation.

Dependencies are exact published artifacts in this module's lock. There is no
private checkout, native agent, provider configuration or filesystem runtime
dependency. The chosen Mermaid version needs its omitted declaration dependency
to keep strict TypeScript library checks enabled; this is a build-time vendor
type dependency, not another renderer owner.
