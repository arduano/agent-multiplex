import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export {
  TRPC_HTTP_BODY_LIMIT_BYTES,
  WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES,
  WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
  installBoundedWebSocketEgress,
} from "./websocket-egress.js";

export interface WebAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface WebAssetOptions {
  /**
   * Per-response CSP nonce granted only to stylesheet elements created by the
   * terminal emulator. The value is surfaced to the client as inert metadata;
   * script execution remains restricted to same-origin assets.
   */
  readonly styleNonce?: string;
}

/** Absolute URL for deployments that prefer their own static-file server. */
export const webDistDirectory = new URL("./client/", import.meta.url);

const root = resolve(fileURLToPath(webDistDirectory));
const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

/**
 * Read one compiled dashboard asset. Paths are URL pathnames, never filesystem
 * paths; malformed encodings, traversal, directories, and missing files fail
 * closed with null.
 */
export function webAsset(
  pathname: string,
  options: WebAssetOptions = {},
): WebAsset | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.split("?", 1)[0] ?? "");
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = decoded === "/" || decoded === "/index.html"
    ? "index.html"
    : decoded.replace(/^\/+/, "");
  if (relative.length === 0 || relative.split("/").includes("..")) return null;
  const filename = resolve(root, relative);
  if (filename !== root && !filename.startsWith(`${root}${sep}`)) return null;
  try {
    if (!statSync(filename).isFile()) return null;
    const extension = extname(filename).toLowerCase();
    const source = readFileSync(filename);
    return {
      body: extension === ".html" && options.styleNonce !== undefined
        ? injectStyleNonce(source, options.styleNonce)
        : source,
      contentType: contentTypes[extension] ?? "application/octet-stream",
      cacheControl: extension === ".html"
        ? "no-store"
        : "public, max-age=31536000, immutable",
    };
  } catch {
    return null;
  }
}

/** Backward-compatible helper for embedders that only serve the entry page. */
export function dashboardHtml(options: WebAssetOptions = {}): string {
  const asset = webAsset("/", options);
  if (!asset) {
    throw new Error(
      "Agent Multiplex web assets are missing; run the @arduano/agent-multiplex-web client build",
    );
  }
  return asset.body.toString("utf8");
}

function injectStyleNonce(source: Buffer, nonce: string): Buffer {
  // Nonces are generated as base64url by the HTTP surfaces. Validate here too
  // so this shared asset helper can never become an HTML-injection primitive.
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) {
    throw new Error("Web stylesheet nonce must be at least 16 base64url characters");
  }
  const html = source.toString("utf8");
  const marker = "</head>";
  const offset = html.indexOf(marker);
  if (offset < 0) {
    throw new Error("Agent Multiplex dashboard is missing its closing head element");
  }
  const metadata = `    <meta name="agent-multiplex-style-nonce" content="${nonce}" />\n  `;
  return Buffer.from(`${html.slice(0, offset)}${metadata}${html.slice(offset)}`, "utf8");
}
