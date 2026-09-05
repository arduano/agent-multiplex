import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" fill="#14181e"/><circle cx="120" cy="120" r="68" fill="#46b8ff"/><path d="M260 60h140v120H260z" fill="#47c98b"/></svg>`;
export const hostileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><script>fetch('https://image-fixture.invalid/script');parent.imageFixtureExecuted=true</script><image href="https://image-fixture.invalid/resource" width="20" height="20"/><rect width="320" height="160" fill="#e6ad52"/><text x="20" y="90" font-size="20">SVG image context</text></svg>`;
if (process.argv[1]?.endsWith("image-fixtures.mjs") && process.argv[2]) {
  await mkdir(process.argv[2], { recursive: true });
  for (const [name, data] of [["pixel.png", png], ["shapes.svg", svg], ["inert.svg", hostileSvg]]) await writeFile(join(process.argv[2], name), data);
}
