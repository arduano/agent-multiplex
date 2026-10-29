import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { proposedPlan } from "../../interactions/index.js";
import type { MarkdownProps } from "../contracts.js";
import { FilePreview, Mermaid } from "./preview.js";

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
export function ChatMarkdown({ text, files, reader, renderDiagram }: MarkdownProps) {
  const parsed = proposedPlan(text);
  if (parsed)
    return (
      <>
        <ChatMarkdown
          text={parsed.before}
          {...(files ? { files } : {})}
          {...(reader ? { reader } : {})}
          {...(renderDiagram ? { renderDiagram } : {})}
        />
        <section className="mpx-plan" aria-label="Proposed plan">
          <ChatMarkdown
            text={parsed.plan}
            {...(files ? { files } : {})}
            {...(reader ? { reader } : {})}
            {...(renderDiagram ? { renderDiagram } : {})}
          />
        </section>
        <ChatMarkdown
          text={parsed.after}
          {...(files ? { files } : {})}
          {...(reader ? { reader } : {})}
          {...(renderDiagram ? { renderDiagram } : {})}
        />
      </>
    );
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(value) => value}
      components={{
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
          return safe ? (
            <a
              href={safe}
              rel="noopener noreferrer"
              target={safe.startsWith("#") ? undefined : "_blank"}
            >
              {children}
            </a>
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
      }}
    >
      {text}
    </Markdown>
  );
}
