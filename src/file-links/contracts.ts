import type { FileReadPort } from "../files/contracts.js";
import type { RunRef } from "../protocol/index.js";
import type { Preview } from "../files/contracts.js";
export type FileLink = Readonly<{ run: RunRef; stream: string; rowId: string; href: string }>;
export type FileLinkResult =
  Readonly<{ state: "ready"; preview: Preview }> | Readonly<{ state: "unavailable" }>;
export type FileLinkLease =
  | Readonly<{ state: "ready"; preview: Preview; release(): Promise<void> }>
  | Readonly<{ state: "unavailable" }>;
export type ResolveFile = (link: FileLink) => Promise<FileLinkLease>;
export interface FileLinkResolvePort {
  resolve(link: FileLink): Promise<FileLinkResult>;
}
/** External URLs and fragments keep ordinary navigation. Local candidates still
 * need actual Host occurrence/workspace authority; classification grants none. */
export function localFileLink(href: string): boolean {
  if (
    typeof href !== "string" ||
    !href.length ||
    href.length > 8192 ||
    /[\x00-\x1f\x7f]/.test(href) ||
    href.startsWith("#") ||
    href.startsWith("//")
  )
    return false;
  if (/^file:/i.test(href) || /^[a-z]:[\\/]/i.test(href)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[^/:]+\.[^/:]+:\d+(?::\d+)?$/.test(href);
}

export interface FileLinkResolverOptions {
  capture(link: FileLink): Promise<FileLinkResult>;
  files: FileReadPort;
  identity: Readonly<{ connection: string; principal: string }>;
  maxEntries?: number;
  maxPending?: number;
  maxLeases?: number;
}
