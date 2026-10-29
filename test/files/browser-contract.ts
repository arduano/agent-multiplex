import type { FileReadPort, FileReference, Preview } from "../../src/files/index.js";
// @ts-expect-error The browser barrel does not export a Node owner.
import type { FileStore as _FileStore } from "../../src/files/index.js";
export function browserContract(reference: FileReference, port: FileReadPort, view: Preview): void {
  if (reference.kind === "host") {
    // @ts-expect-error A Host reference never exposes an authorized disk path.
    void reference.path;
  } else {
    void port.acquire(reference.scope, reference);
  }
  if (view.kind === "html") {
    const opaque: "" = view.sandbox;
    void opaque;
  }
  if (view.kind === "mermaid") {
    const strict: "strict" = view.securityLevel;
    void strict;
  }
}
