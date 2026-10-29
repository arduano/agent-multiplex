import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { proposedPlan } from "../../interactions/index.js";
import type { FileReadPort } from "../../files/index.js";
import {
  localFileLink,
  type FileLink,
  type FileLinkLease,
  type ResolveFile,
} from "../../file-links/index.js";
import type { DiagramRenderer, MarkdownProps } from "../contracts.js";
import { FilePreview, Mermaid } from "./preview.js";
import { Button } from "./primitives.js";

/** Only explicit network schemes. Relative/private filesystem text has no
 * navigation or capture authority. Remote images require a deliberate link. */
export function safeLink(href: string): string | undefined {
  if (/^#[^\s]*$/.test(href)) return href;
  try {
    const url = new URL(href);
    if (["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {}
  return undefined;
}
/** A deliberate click captures once. Neither render nor a fresh history frame
 * dispatches I/O. The injected owner retains pending work; this occurrence
 * releases its actual lease even when capture settles after unmount. */
function ResolvedFileLink({
  link,
  resolve,
  children,
  reader,
  renderDiagram,
}: Readonly<{
  link: FileLink;
  resolve: ResolveFile;
  children: ReactNode;
  reader?: FileReadPort;
  renderDiagram?: DiagramRenderer;
}>) {
  const owned = useRef<{
    active: boolean;
    started: boolean;
    lease?: Extract<FileLinkLease, { state: "ready" }>;
  }>({ active: true, started: false });
  const [result, setResult] = useState<FileLinkLease | null>(null),
    [pending, setPending] = useState(false);
  useEffect(() => {
    const occurrence = owned.current;
    occurrence.active = true;
    return () => {
      occurrence.active = false;
      if (occurrence.lease) void occurrence.lease.release().catch(() => {});
    };
  }, []);
  const capture = () => {
    const occurrence = owned.current;
    if (occurrence.started) return;
    occurrence.started = true;
    setPending(true);
    void Promise.resolve()
      .then(() => resolve(link))
      .then(
        (value) => {
          if (value.state === "ready") occurrence.lease = value;
          if (!occurrence.active) {
            if (value.state === "ready") void value.release().catch(() => {});
            return;
          }
          setResult(value);
          setPending(false);
        },
        () => {
          if (occurrence.active) {
            setResult({ state: "unavailable" });
            setPending(false);
          }
        },
      );
  };
  if (result?.state === "ready")
    return (
      <FilePreview
        descriptor={result.preview}
        {...(typeof children === "string" ? { label: children } : {})}
        {...(reader ? { reader } : {})}
        {...(renderDiagram ? { renderDiagram } : {})}
      />
    );
  return (
    <span className="mpx-file">
      <Button
        onClick={capture}
        disabled={pending || result?.state === "unavailable"}
        aria-label={`Preview ${link.href}`}
      >
        {pending ? (
          "Loading preview…"
        ) : result?.state === "unavailable" ? (
          "Preview unavailable"
        ) : (
          <>{children} · Preview</>
        )}
      </Button>
    </span>
  );
}
export function ChatMarkdown({
  text,
  files,
  reader,
  renderDiagram,
  resolveFile,
  fileContext,
}: MarkdownProps) {
  const contextKey = fileContext ? JSON.stringify(fileContext) : "";
  // Stable renderer identities keep a clicked preview mounted while native
  // text/rows stream. Capturing a fresh closure on every frame loses its lease.
  const components = useMemo<Components>(
    () => ({
      a({ href = "", children }) {
        const file = files?.[href];
        if (file)
          return (
            <FilePreview
              descriptor={file}
              {...(reader ? { reader } : {})}
              {...(renderDiagram ? { renderDiagram } : {})}
            />
          );
        const safe = safeLink(href);
        if (safe)
          return (
            <a
              href={safe}
              rel="noopener noreferrer"
              target={safe.startsWith("#") ? undefined : "_blank"}
            >
              {children}
            </a>
          );
        return resolveFile && fileContext && localFileLink(href) ? (
          <ResolvedFileLink
            key={`${contextKey}:${href}`}
            link={{ ...fileContext, href }}
            resolve={resolveFile}
            {...(reader ? { reader } : {})}
            {...(renderDiagram ? { renderDiagram } : {})}
          >
            {children}
          </ResolvedFileLink>
        ) : (
          <span>{children}</span>
        );
      },
      img({ src = "", alt = "Image" }) {
        const file = files?.[src];
        if (file)
          return (
            <FilePreview
              descriptor={file}
              label={alt}
              {...(reader ? { reader } : {})}
              {...(renderDiagram ? { renderDiagram } : {})}
            />
          );
        if (resolveFile && fileContext && localFileLink(src))
          return (
            <ResolvedFileLink
              key={`${contextKey}:${src}`}
              link={{ ...fileContext, href: src }}
              resolve={resolveFile}
              {...(reader ? { reader } : {})}
              {...(renderDiagram ? { renderDiagram } : {})}
            >
              {alt}
            </ResolvedFileLink>
          );
        const safe = safeLink(src);
        return safe && /^https?:/.test(safe) ? (
          <a href={safe} target="_blank" rel="noopener noreferrer">
            {alt} (external image)
          </a>
        ) : (
          <span>{alt}</span>
        );
      },
      pre({ children }) {
        return <div className="mpx-code">{children}</div>;
      },
      code({ className, children }) {
        const source = String(children).replace(/\n$/, "");
        return className === "language-mermaid" ? (
          <Mermaid source={source} {...(renderDiagram ? { renderer: renderDiagram } : {})} />
        ) : (
          <code className={className}>{children}</code>
        );
      },
    }),
    [files, reader, renderDiagram, resolveFile, contextKey],
  );
  const parsed = proposedPlan(text);
  const shared = {
    ...(files ? { files } : {}),
    ...(reader ? { reader } : {}),
    ...(renderDiagram ? { renderDiagram } : {}),
    ...(resolveFile ? { resolveFile } : {}),
    ...(fileContext ? { fileContext } : {}),
  };
  if (parsed)
    return (
      <>
        <ChatMarkdown text={parsed.before} {...shared} />
        <section className="mpx-plan" aria-label="Proposed plan">
          <ChatMarkdown text={parsed.plan} {...shared} />
        </section>
        <ChatMarkdown text={parsed.after} {...shared} />
      </>
    );
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(value) => value}
      components={components}
    >
      {text}
    </Markdown>
  );
}
