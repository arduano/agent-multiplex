import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { FileReadPort, StoredFile } from "../../files/index.js";
import { scopeKey } from "../../protocol/index.js";
import type { DiagramLease, DiagramRenderer, FilePreviewProps } from "../contracts.js";
import { Button, Dialog } from "./primitives.js";

const MAX_BYTES = 16 * 1024 * 1024;
/** Real scoped lease, bounded reads, exact release even on partial read/error.
 * UI cancellation does not pretend to cancel an already admitted acquisition. */
export async function readPreviewBytes(
  reader: FileReadPort,
  file: StoredFile,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_BYTES)
    throw new Error("PREVIEW_TOO_LARGE");
  const lease = await reader.acquire(file.scope, file);
  try {
    const bytes = new Uint8Array(file.bytes);
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(256 * 1024, bytes.length - offset),
        part = await lease.read(offset, length);
      if (part.length !== length) throw new Error("PREVIEW_INCOMPLETE");
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } finally {
    await lease.release();
  }
}
/** Focal point in document coordinates remains under the same viewport pixel. */
export function focalOffset(scroll: number, point: number, previous: number, next: number): number {
  return Math.max(0, ((scroll + point) * next) / previous - point);
}
function ImageViewer({ url, label }: Readonly<{ url: string; label: string }>) {
  const viewport = useRef<HTMLDivElement>(null),
    [scale, setScale] = useState(1),
    current = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; scale: number } | null>(null);
  const zoom = (next: number, x?: number, y?: number) => {
    const element = viewport.current;
    next = Math.min(8, Math.max(1, next));
    if (!element) return;
    const old = current.current,
      left = focalOffset(element.scrollLeft, x ?? element.clientWidth / 2, old, next),
      top = focalOffset(element.scrollTop, y ?? element.clientHeight / 2, old, next);
    current.current = next;
    setScale(next);
    requestAnimationFrame(() => {
      if (viewport.current === element) {
        element.scrollLeft = left;
        element.scrollTop = top;
      }
    });
  };
  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 1 && previous) {
      event.currentTarget.scrollLeft += previous.x - event.clientX;
      event.currentTarget.scrollTop += previous.y - event.clientY;
    }
    if (points.length !== 2) return;
    const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }],
      distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pinch.current) pinch.current = { distance, scale: current.current };
    else {
      const rect = event.currentTarget.getBoundingClientRect();
      zoom(
        (pinch.current.scale * distance) / Math.max(1, pinch.current.distance),
        (a.x + b.x) / 2 - rect.left,
        (a.y + b.y) / 2 - rect.top,
      );
    }
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
  };
  return (
    <>
      <div className="mpx-preview-controls">
        <Button aria-label="Zoom out" disabled={scale <= 1} onClick={() => zoom(scale / 1.5)}>
          −
        </Button>
        <output aria-label="Image zoom">{Math.round(scale * 100)}%</output>
        <Button aria-label="Zoom in" disabled={scale >= 8} onClick={() => zoom(scale * 1.5)}>
          +
        </Button>
        <Button onClick={() => zoom(1)}>Fit</Button>
        <a href={url} download>
          Download
        </a>
      </div>
      <div
        ref={viewport}
        className="mpx-image-viewer"
        tabIndex={0}
        role="region"
        aria-label={label}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer(event);
        }}
        onPointerMove={(event) => {
          if (pointers.current.has(event.pointerId)) pointer(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <img
          src={url}
          alt={label}
          draggable={false}
          style={{ width: `${scale * 100}%`, maxWidth: "none" }}
        />
      </div>
    </>
  );
}
export function Mermaid({
  source,
  renderer,
}: Readonly<{ source: string; renderer?: DiagramRenderer }>) {
  const [result, setResult] = useState<DiagramLease | null>(null),
    [failed, setFailed] = useState(false),
    [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!renderer || !requested) return;
    let active = true,
      retained: DiagramLease | undefined;
    setFailed(false);
    setResult(null);
    void renderer(source, { securityLevel: "strict" }).then(
      (value) => {
        retained = value;
        if (active) setResult(value);
        else void Promise.resolve(value.release()).catch(() => {});
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      if (retained) void Promise.resolve(retained.release()).catch(() => {});
    };
  }, [source, renderer, requested]);
  return (
    <section className="mpx-diagram" aria-label="Mermaid diagram">
      {result ? (
        <Dialog
          title="Diagram"
          trigger={
            <Button>
              <img className="mpx-thumbnail" src={result.url} alt="Diagram" />
            </Button>
          }
        >
          <ImageViewer url={result.url} label="Diagram" />
        </Dialog>
      ) : renderer ? (
        <Button onClick={() => setRequested(true)} disabled={requested}>
          {failed
            ? "Diagram could not be rendered"
            : requested
              ? "Rendering diagram…"
              : "Show diagram"}
        </Button>
      ) : (
        <p className="mpx-hint">Diagram renderer not configured</p>
      )}
      <details>
        <summary>Diagram source</summary>
        <pre>{source}</pre>
      </details>
    </section>
  );
}
export function FilePreview(props: FilePreviewProps) {
  const { file } = props.descriptor;
  return (
    <FilePreviewOwner
      key={JSON.stringify([scopeKey(file.scope), file.id, file.sha256, props.descriptor.kind])}
      {...props}
    />
  );
}
function FilePreviewOwner({
  descriptor,
  reader,
  label = descriptor.file.name,
  renderDiagram,
}: FilePreviewProps) {
  const mount = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false),
    [requested, setRequested] = useState(false),
    [url, setUrl] = useState<string | null>(null),
    [failed, setFailed] = useState(false);
  const file = descriptor.file,
    identity = JSON.stringify([
      scopeKey(file.scope),
      file.id,
      file.sha256,
      file.bytes,
      file.mediaType,
    ]);
  useEffect(() => {
    const target = mount.current;
    if (!target || descriptor.kind !== "image") return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [identity, descriptor.kind]);
  const enabled =
    ["image", "pdf", "download"].includes(descriptor.kind) &&
    (requested || (visible && descriptor.kind === "image"));
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!reader || !enabled) return;
    let active = true,
      owned: string | undefined;
    void readPreviewBytes(reader, file).then(
      (bytes) => {
        if (!active) return;
        // A modified-click on a download must not turn captured HTML/SVG into
        // application-origin executable content in a fresh tab.
        const type = descriptor.kind === "download" ? "application/octet-stream" : file.mediaType;
        owned = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setUrl(owned);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [reader, identity, enabled]);
  if (descriptor.kind === "mermaid")
    return (
      <Mermaid source={descriptor.text} {...(renderDiagram ? { renderer: renderDiagram } : {})} />
    );
  const content =
    descriptor.kind === "text" ? (
      <pre className="mpx-text-preview" tabIndex={0}>
        {descriptor.text}
      </pre>
    ) : descriptor.kind === "html" ? (
      <iframe
        title={label}
        className="mpx-document"
        sandbox={descriptor.sandbox}
        referrerPolicy="no-referrer"
        srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${descriptor.csp.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${descriptor.text}`}
      />
    ) : url ? (
      descriptor.kind === "image" ? (
        <ImageViewer url={url} label={label} />
      ) : descriptor.kind === "pdf" ? (
        <>
          <iframe title={label} className="mpx-document" src={url} />
          <a href={url} download={file.name}>
            Download PDF
          </a>
        </>
      ) : (
        <a href={url} download={file.name}>
          Download {file.name}
        </a>
      )
    ) : (
      <p role="status">
        {failed
          ? "File could not be loaded"
          : !reader
            ? "File reader not configured"
            : "Loading file…"}
      </p>
    );
  return (
    <span ref={mount} className="mpx-file">
      <Dialog
        title={label}
        onOpenChange={setRequested}
        trigger={
          <Button
            className={descriptor.kind === "image" ? "mpx-thumbnail-button" : ""}
            aria-label={`Open ${label}`}
          >
            {descriptor.kind === "image" && url ? (
              <img className="mpx-thumbnail" alt={label} src={url} />
            ) : (
              label
            )}
          </Button>
        }
      >
        {content}
      </Dialog>
      {failed && <span className="mpx-hint"> Preview unavailable</span>}
    </span>
  );
}
