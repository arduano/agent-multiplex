import type { DiagramRenderer } from "../../chat/index.js";

/** Explicit library port. The reference boot supplies the actual pinned Mermaid
 * module; the optional renderer does not make it a core/client dependency. */
export interface MermaidEngine {
  initialize(config: {
    startOnLoad: false;
    securityLevel: "strict";
    theme: "default";
    maxTextSize: number;
    maxEdges: number;
    suppressErrorRendering: true;
    flowchart: { htmlLabels: false };
  }): void;
  render(id: string, source: string, container: Element): Promise<{ svg: string }>;
}
/** Import/creation is inert. Each gesture owns its temporary engine DOM and
 * returns only an image lease; no rendered SVG enters application HTML. */
export function createMermaidRenderer(
  options: Readonly<{ load(): Promise<MermaidEngine>; container: HTMLElement }>,
): DiagramRenderer {
  return async (source) => {
    if (new TextEncoder().encode(source).length > 65536 || !options.container.isConnected)
      throw new Error("DIAGRAM_UNAVAILABLE");
    const engine = await options.load();
    if (!options.container.isConnected) throw new Error("DIAGRAM_UNAVAILABLE");
    const held = options.container.ownerDocument.createElement("div");
    held.setAttribute("aria-hidden", "true");
    held.style.cssText = "position:absolute;left:-10000px;top:0;width:1024px;pointer-events:none";
    options.container.append(held);
    try {
      engine.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
        maxTextSize: 65536,
        maxEdges: 500,
        suppressErrorRendering: true,
        flowchart: { htmlLabels: false },
      });
      const result = await engine.render(`diagram-${crypto.randomUUID()}`, source, held);
      if (new TextEncoder().encode(result.svg).length > 2 * 1024 * 1024)
        throw new Error("DIAGRAM_TOO_LARGE");
      const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
      let released = false;
      return {
        url,
        release() {
          if (!released) {
            released = true;
            URL.revokeObjectURL(url);
          }
        },
      };
    } finally {
      held.remove();
    }
  };
}
