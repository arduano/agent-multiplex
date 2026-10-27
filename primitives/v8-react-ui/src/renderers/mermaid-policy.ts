/** Pure admission shared by the parent and isolated renderer; never an effect. */
export const diagramLimits = Object.freeze({ source: 16_000, statements: 240, edges: 180, nodes: 4_000, output: 1_000_000, dimension: 12_000, pixels: 24_000_000, scriptBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
export type Diagram = Readonly<{ svg: string; width: number; height: number }>;

export function prepareDiagram(value: string): string {
  if (value.length > diagramLimits.source) throw new Error('This diagram is too large to render. Its source is available below.');
  let source = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^---[^\S\n]*(?:\n|$)/.test(source)) {
    const header = source.match(/^---[^\S\n]*\n[\s\S]*?\n[^\S\n]*---[^\S\n]*(?:\n|$)/);
    if (!header) throw new Error('The diagram configuration is incomplete.');
    source = source.slice(header[0].length).trim();
  }
  source = source.replace(/%%\{[\s\S]*?\}%%/g, '');
  if (!source.trim() || /%%\{/.test(source)) throw new Error('The diagram source is incomplete.');
  if (source.split(/[\n;]/).length > diagramLimits.statements || (source.match(/(?:--|==|\.\.)[>|\-]|->>|-->>|--\)|-\)/g)?.length ?? 0) > diagramLimits.edges) throw new Error('This diagram has too many steps to render. Its source is available below.');
  return source.trim();
}

export function validateDiagram(value: unknown): Diagram {
  if (!value || typeof value !== 'object') throw new Error('The diagram could not be rendered.');
  const data = value as Partial<Diagram>;
  if (typeof data.svg !== 'string' || !data.svg.startsWith('<svg') || data.svg.length > diagramLimits.output || typeof data.width !== 'number' || typeof data.height !== 'number' || !Number.isFinite(data.width) || !Number.isFinite(data.height) || data.width <= 0 || data.height <= 0 || data.width > diagramLimits.dimension || data.height > diagramLimits.dimension || data.width * data.height > diagramLimits.pixels) throw new Error('This diagram is too large to display. Its source is available below.');
  return Object.freeze({ svg: data.svg, width: data.width, height: data.height });
}

/** Closed fence evidence comes from the Markdown parser's original offsets. */
export function closedDiagramFence(source: string): boolean {
  const lines = source.trimEnd().split(/\r?\n/), opening = lines[0]?.match(/^\s*(`{3,}|~{3,})/), closing = lines.at(-1)?.replace(/^(?: {0,3}> ?)+/, '').match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(lines.length > 1 && opening && closing && opening[1]![0] === closing[1]![0] && closing[1]!.length >= opening[1]!.length);
}
