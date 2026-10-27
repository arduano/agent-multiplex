import mermaid from 'mermaid';
import { prepareDiagram, validateDiagram, diagramLimits, type Diagram } from './mermaid-policy.js';

/** Fixed packaged IIFE, executed only in an opaque sandbox with no network. */
let rendering = false;
function unsafeCss(value: string): boolean {
  return /\\|@import|@font-face|(?:animation|transition)\s*:|expression\s*\(/i.test(value) || [...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(match => !/^\s*['"]?#[\w:.-]+['"]?\s*$/.test(match[1] ?? ''));
}
function safeStylesheet(value: string): string {
  const sheet = new CSSStyleSheet(); sheet.replaceSync(value); const rules: string[] = [];
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule) || unsafeCss(rule.selectorText)) continue;
    const declarations: string[] = [];
    for (const property of rule.style) { const content = rule.style.getPropertyValue(property); if (!/^(?:animation|transition)/i.test(property) && !unsafeCss(content)) declarations.push(`${property}:${content}${rule.style.getPropertyPriority(property) ? ' !important' : ''}`); }
    if (declarations.length) rules.push(`${rule.selectorText}{${declarations.join(';')}}`);
  }
  return rules.join('\n');
}
function safeSvg(value: string): Diagram {
  if (value.length > diagramLimits.output) throw new Error('size');
  const parsed = new DOMParser().parseFromString(value, 'image/svg+xml'), svg = parsed.documentElement;
  if (svg.localName !== 'svg' || parsed.querySelector('parsererror') || svg.querySelectorAll('*').length > diagramLimits.nodes) throw new Error('svg');
  for (const element of [...svg.querySelectorAll('*')]) {
    const name = element.localName.toLowerCase();
    if (['script', 'foreignobject', 'image', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animatemotion', 'animatetransform', 'set', 'feimage'].includes(name)) { element.remove(); continue; }
    if (name === 'a') element.replaceWith(...element.childNodes);
  }
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase(), content = attribute.value;
      if (name.startsWith('on') || name === 'nonce' || name === 'target' || ((name === 'href' || name === 'src') && !(element.localName === 'use' && /^#[\w:.-]+$/.test(content))) || ((name === 'style' || /url\s*\(/i.test(content)) && unsafeCss(content))) element.removeAttributeNode(attribute);
    }
    if (element.localName === 'style') element.textContent = safeStylesheet(element.textContent ?? '');
  }
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number), width = box?.length === 4 ? box[2] : Number.parseFloat(svg.getAttribute('width') ?? ''), height = box?.length === 4 ? box[3] : Number.parseFloat(svg.getAttribute('height') ?? '');
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return validateDiagram({ svg: new XMLSerializer().serializeToString(svg), width, height });
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || rendering || event.data?.type !== 'multiplex.diagram.render' || typeof event.data.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(event.data.id) || typeof event.data.source !== 'string') return;
  const { id, source } = event.data as { id: string; source: string }; rendering = true;
  void (async () => {
    try {
      const config = { startOnLoad: false, securityLevel: 'strict' as const, suppressErrorRendering: true, htmlLabels: false, theme: 'dark' as const, fontFamily: 'Arial, sans-serif', maxTextSize: diagramLimits.source, maxEdges: diagramLimits.edges, logLevel: 'fatal' as const, deterministicIds: true };
      mermaid.initialize({ ...config, secure: Object.keys(config) });
      const result = await mermaid.mermaidAPI.render(`mpx${id.replaceAll('-', '')}`, prepareDiagram(source));
      window.parent.postMessage({ type: 'multiplex.diagram.result', id, diagram: safeSvg(result.svg) }, '*');
    } catch { window.parent.postMessage({ type: 'multiplex.diagram.result', id, error: true }, '*'); }
    finally { document.body.replaceChildren(); rendering = false; }
  })();
});
window.parent.postMessage({ type: 'multiplex.diagram.ready' }, '*');
