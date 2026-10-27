const encode = (text: string) => new TextEncoder().encode(text);
export const interactiveHtml = `<!doctype html><html><head><style>h1{color:rgb(12,90,123)}body{font:16px system-ui;margin:16px}</style></head><body><h1>Interactive isolated document</h1><button id="counter">Count: 0</button><p id="section">Document fragment</p><script>
let count=0;document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='Count: '+(++count)};
try{parent.document.body.dataset.unsafe='parent';document.body.dataset.parent='accessible'}catch{document.body.dataset.parent='blocked'}
try{document.body.dataset.cookie=document.cookie||'empty'}catch{document.body.dataset.cookie='blocked'}
fetch('/private-api').then(()=>document.body.dataset.network='accessible',()=>document.body.dataset.network='blocked');
fetch('https://outside.invalid/blocked').catch(()=>{});
</script><img alt="Embedded pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="><img alt="Blocked external pixel" src="https://outside.invalid/image.png"></body></html>`;
export function exampleDocumentPdf(count = 16): Uint8Array {
  const objects = ['', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`];
  const font = 3 + count * 2;
  for (let i = 1; i <= count; i++) {
    const content = `BT /F1 10 Tf 20 360 Td (Verified continuous PDF page ${i}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + (i - 1) * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(unsafe\\)) >> >>';
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = text.length; text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(text);
}
export const documentData = [
  { id: 'markdown', name: 'guide.md', mediaType: 'text/markdown', bytes: encode('# Document preview\n\n[Child file](child.txt)\n\n![Local illustration](picture.png)\n\n' + 'A paragraph in the full document.\n\n'.repeat(80)) },
  { id: 'large', name: 'complete.md', mediaType: 'text/markdown', bytes: encode('# Full source retained\n\n' + 'readable text '.repeat(12_000) + '\n\nFULL_SOURCE_END') },
  { id: 'html', name: 'interactive.html', mediaType: 'text/html', bytes: encode(interactiveHtml) },
  { id: 'pdf', name: 'continuous.pdf', mediaType: 'application/pdf', bytes: exampleDocumentPdf() },
  { id: 'diagram', name: 'architecture.mmd', mediaType: 'text/plain', bytes: encode('flowchart LR\n A[Source] --> B[Viewer]') },
  { id: 'text', name: 'escaped.txt', mediaType: 'text/plain', bytes: encode('<script>unsafe_document_code()</script>\n' + 'Full escaped source\n'.repeat(50)) },
];
