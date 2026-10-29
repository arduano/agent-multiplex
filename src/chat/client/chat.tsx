import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  EntrySnapshot,
  SessionView,
  TranscriptSnapshot,
  TranscriptViewPort,
} from "../../client/contracts.js";
import type { Row } from "../../history/index.js";
import { optionalQuestions } from "../../interactions/index.js";
import { scopeKey } from "../../protocol/index.js";
import { useTranscriptViewport, useReadonlyTranscriptViewport } from "../../react/index.js";
import type {
  ChatProps,
  ReadonlyTranscriptProps,
  SessionListView,
  SessionListItem,
  SessionListProps,
} from "../contracts.js";
import { ChatMarkdown } from "./markdown.js";
import { FilePreview } from "./preview.js";
import { Button, Dialog, PortalScope, Textarea } from "./primitives.js";
import { RequestArea } from "./prompts.js";
const noUploads = Object.freeze({
  revision: 0,
  busy: false,
  uploads: [] as const,
});
const noUploadSnapshot = () => noUploads;
const noUploadSubscribe = () => () => {};

const equalRun = (a: EntrySnapshot["state"], b: EntrySnapshot["history"]["current"]): boolean =>
  !!a?.run &&
  !!b &&
  a.run.generation === b.scope.run.generation &&
  a.run.nativeSession === b.scope.run.nativeSession &&
  scopeKey(a.run.scope) === scopeKey(b.scope.run.scope);
export const nativeWorking = (snapshot: EntrySnapshot): boolean =>
  snapshot.freshness === "current" &&
  !!snapshot.state?.run &&
  snapshot.state.phase === "running" &&
  snapshot.state.activity === "working";
export function rowInProgress(row: Row, snapshot: EntrySnapshot | TranscriptSnapshot): boolean {
  const current = snapshot.history.current,
    origin = snapshot.history.origins[row.id];
  return (
    ("state" in snapshot
      ? nativeWorking(snapshot) && equalRun(snapshot.state, current)
      : snapshot.working) &&
    ("state" in snapshot ? snapshot.historyFreshness : snapshot.freshness) === "current" &&
    !!current &&
    !!origin &&
    origin.generation === current.generation &&
    JSON.stringify(origin.scope) === JSON.stringify(current.scope) &&
    current.activity.state === "working" &&
    current.activity.turnId !== null &&
    row.native.turnId === current.activity.turnId &&
    row.lifecycle === "running" &&
    !current.gaps.some((gap) => gap.kind === "captureLost" || gap.kind === "identity")
  );
}
export function CompactionNotice({ row, active }: Readonly<{ row: Row; active: boolean }>) {
  let label = "Last observed: compacting context";
  if (row.lifecycle === "failed") label = "Context compaction failed";
  else if (row.lifecycle === "interrupted") label = "Context compaction interrupted";
  else if (row.lifecycle === "completed" && row.native.completed === true)
    label = "Context compacted";
  else if (active) label = "Compacting context…";
  return (
    <p className="mpx-compaction">
      {active && <span className="mpx-spinner" aria-hidden />}
      {label}
    </p>
  );
}
export function HistoryRow({
  row,
  snapshot,
  props,
  onChoice,
}: Readonly<{
  row: Row;
  snapshot: EntrySnapshot | TranscriptSnapshot;
  props: Pick<ChatProps, "actions" | "files" | "media" | "markdownFiles" | "renderDiagram">;
  onChoice?(text: string): void;
}>) {
  const active = rowInProgress(row, snapshot),
    body = row.body,
    text = body.kind === "unavailable" ? "" : body.text,
    origin = snapshot.history.origins[row.id];
  // Build the rich body once, retaining native bytes and exact missing evidence.
  const rich = (
    <ChatMarkdown
      text={text}
      {...(props.markdownFiles ? { files: props.markdownFiles } : {})}
      {...(props.files ? { reader: props.files } : {})}
      {...(props.renderDiagram ? { renderDiagram: props.renderDiagram } : {})}
    />
  );
  const isCompaction = row.native.type === "contextCompaction" && row.kind === "notice",
    error = row.native.type === "error" && row.kind === "notice";
  const missing =
    body.kind === "partial" ? body.missing.filter((kind) => !(active && kind === "final")) : [];
  const gapDetails = missing.length ? (
    <details className="mpx-coverage">
      <summary>{row.kind === "tool" ? "Partial output" : "Message excerpt"}</summary>
      <p>Missing: {missing.join(", ")}</p>
    </details>
  ) : null;
  const optional =
    row.kind === "assistant"
      ? optionalQuestions(row.native.questions)
      : { questions: [], omitted: 0 };
  const implement = props.actions.implementPlan,
    current = snapshot.history.current;
  const rootSnapshot = "state" in snapshot ? snapshot : undefined;
  const nativePlan =
    !!rootSnapshot &&
    row.native.type === "plan" &&
    row.kind === "assistant" &&
    row.lifecycle === "completed" &&
    body.kind === "complete" &&
    rootSnapshot.freshness === "current" &&
    rootSnapshot.historyFreshness === "current" &&
    equalRun(rootSnapshot.state, current) &&
    !!origin &&
    !!current &&
    origin.generation === current.generation &&
    JSON.stringify(origin.scope) === JSON.stringify(current.scope);
  return (
    <article
      className={`mpx-row mpx-row--${row.kind}${error ? " mpx-row--error" : ""}`}
      data-history-row={row.id}
      data-kind={row.kind}
      data-lifecycle={row.lifecycle}
    >
      <header>
        {error
          ? row.native.retry === true
            ? "Retrying"
            : "Agent error"
          : row.kind === "user"
            ? "You"
            : row.kind === "tool"
              ? String(row.native.type ?? "Tool")
              : row.kind === "notice"
                ? "Notice"
                : row.kind === "reasoning"
                  ? "Reasoning"
                  : "Agent"}
      </header>
      {isCompaction ? (
        <CompactionNotice row={row} active={active} />
      ) : row.kind === "tool" ? (
        <details className="mpx-tool">
          <summary>
            {active
              ? "Running…"
              : row.lifecycle === "failed"
                ? "Tool failed"
                : row.lifecycle === "interrupted"
                  ? "Tool interrupted"
                  : "Tool output"}
          </summary>
          {text ? (
            <pre tabIndex={0} role="region" aria-label="Tool output">
              {text}
            </pre>
          ) : (
            <p>Tool output not captured</p>
          )}
          {gapDetails}
        </details>
      ) : row.kind === "reasoning" ? (
        <details>
          <summary>Reasoning</summary>
          {rich}
          {gapDetails}
        </details>
      ) : (
        <>
          {text ? (
            rich
          ) : (
            <p className="mpx-hint">
              {body.kind === "unavailable" && body.reason === "nativeOmitted"
                ? "No text was provided"
                : "Message text not captured"}
            </p>
          )}
          {gapDetails}
        </>
      )}
      {props.media?.(row).map((item, index) => (
        <FilePreview
          key={`${item.preview.file.id}:${index}`}
          descriptor={item.preview}
          {...(item.label ? { label: item.label } : {})}
          {...(props.files ? { reader: props.files } : {})}
          {...(props.renderDiagram ? { renderDiagram: props.renderDiagram } : {})}
        />
      ))}
      {optional.questions.map((question, index) => (
        <fieldset className="mpx-optional" key={index}>
          <legend>{question.title}</legend>
          {question.options.map((option) => (
            <Button key={option} disabled={!onChoice} onClick={() => onChoice?.(option)}>
              {option}
            </Button>
          ))}
        </fieldset>
      ))}
      {!!optional.omitted && <p className="mpx-hint">Some optional choices were omitted.</p>}
      {nativePlan && rootSnapshot && implement?.available(row, rootSnapshot) && (
        <PlanButton invoke={() => implement.invoke(row, rootSnapshot)} />
      )}
    </article>
  );
}
function PlanButton({ invoke }: Readonly<{ invoke(): Promise<unknown> }>) {
  const [held, setHeld] = useState(false),
    [issue, setIssue] = useState(false),
    admitting = useRef(false);
  return (
    <>
      <Button
        variant="primary"
        disabled={held}
        onClick={() => {
          if (admitting.current) return;
          admitting.current = true;
          setHeld(true);
          void Promise.resolve()
            .then(invoke)
            .catch(() => setIssue(true));
        }}
      >
        Implement plan
      </Button>
      {issue && (
        <p className="mpx-error" role="alert">
          Plan operation completion is unconfirmed. Check its original.
        </p>
      )}
    </>
  );
}
function HistoryBoundary({
  view,
  snapshot,
}: Readonly<{
  view: Pick<TranscriptViewPort, "baseline" | "older">;
  snapshot: EntrySnapshot | TranscriptSnapshot;
}>) {
  const [issue, setIssue] = useState(false),
    edge = snapshot.history.current?.olderEdge,
    pending = ("state" in snapshot ? snapshot.historyRead : snapshot.read)?.state === "pending";
  const read = () => {
    setIssue(false);
    void (edge?.state === "available" ? view.older(edge.cursor) : view.baseline()).then(
      (value) => {
        if (value.state !== "ready") setIssue(true);
      },
      () => setIssue(true),
    );
  };
  return (
    <div className="mpx-history-boundary">
      {edge?.state === "end" ? (
        <p className="mpx-hint">Beginning of available history</p>
      ) : (
        <>
          <Button disabled={pending || snapshot.freshness !== "current"} onClick={read}>
            {pending
              ? "Loading history…"
              : edge?.state === "available"
                ? "Load earlier history"
                : "Check history"}
          </Button>
          {edge?.state === "unknown" && <p className="mpx-hint">{edge.reason}</p>}
        </>
      )}
      {issue && (
        <p role="status">History could not be established. Existing messages remain available.</p>
      )}
    </div>
  );
}
function Composer({
  view,
  snapshot,
  props,
}: Readonly<{ view: SessionView; snapshot: EntrySnapshot; props: ChatProps }>) {
  const textarea = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    admitting = useRef(false),
    [sending, setSending] = useState(false),
    [issue, setIssue] = useState("");
  const attachments = props.attachments;
  const uploadStore = useMemo(
    () => ({
      subscribe: attachments ? attachments.subscribe.bind(attachments) : noUploadSubscribe,
      getSnapshot: attachments ? attachments.getSnapshot.bind(attachments) : noUploadSnapshot,
    }),
    [attachments],
  );
  const uploads = useSyncExternalStore(
    uploadStore.subscribe,
    uploadStore.getSnapshot,
    uploadStore.getSnapshot,
  );
  const attachmentBlocked = uploads.busy || uploads.uploads.some((upload) => !upload.removed);
  const attachable =
    !props.readOnly &&
    !!props.attachments &&
    props.attachments.owner === view.entry.owner &&
    snapshot.state?.phase !== "archived";
  const addFiles = (files: readonly File[]) => {
    if (!attachable || !files.length) return;
    setIssue("");
    try {
      void props
        .attachments!.add(files)
        .catch(() =>
          setIssue("Attachment upload was not confirmed. Check the upload or remove it."),
        );
    } catch {
      setIssue("Attachment exceeds the available file or byte limit.");
    }
  };
  useEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(240, Math.max(44, element.scrollHeight))}px`;
    }
  }, [snapshot.draft]);
  const send = () => {
    if (admitting.current || props.readOnly || !props.actions.draft || attachmentBlocked) return;
    setIssue("");
    try {
      const latest = view.entry.getSnapshot();
      if (!latest.draft.trim() && !latest.attachments.length) return;
      const original = props.actions.draft(latest.draft, latest);
      admitting.current = true;
      setSending(true);
      void view
        .submitDraft(original)
        .catch(() => setIssue("Message was not locally admitted. Your draft is retained."))
        .finally(() => {
          admitting.current = false;
          setSending(false);
        });
    } catch {
      admitting.current = false;
      setSending(false);
      setIssue("Message was not locally admitted. Your draft is retained.");
    }
  };
  return (
    <form
      className="mpx-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          addFiles([...event.dataTransfer.files]);
        }
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          if (!event.clipboardData.getData("text/plain")) event.preventDefault();
          addFiles([...event.clipboardData.files]);
        }
      }}
    >
      <Textarea
        ref={textarea}
        readOnly={props.readOnly}
        aria-label="Message"
        placeholder="Message the agent…"
        value={snapshot.draft}
        rows={1}
        onChange={(event) => {
          void view.entry
            .setDraft(event.currentTarget.value)
            .catch(() => setIssue("Draft could not be saved."));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      {(snapshot.attachments.length > 0 || uploads.uploads.length > 0) && (
        <ul className="mpx-draft-attachments" aria-label="Attachments">
          {snapshot.attachments.map((file) => (
            <li key={file.id}>
              <span>{file.name}</span>
              <Button
                disabled={props.readOnly}
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  void view.entry
                    .setAttachments(
                      view.entry.getSnapshot().attachments.filter((value) => value.id !== file.id),
                    )
                    .catch(() => setIssue("Attachment draft could not be saved."))
                }
              >
                Remove
              </Button>
            </li>
          ))}
          {uploads.uploads.map((upload) => (
            <li key={upload.id}>
              <span>
                {upload.removed
                  ? "Finishing removed upload…"
                  : `${upload.name} · ${upload.state === "uploading" ? "Uploading…" : upload.state === "failed" ? "Upload failed" : "Upload not confirmed"}`}
              </span>
              {upload.state === "unconfirmed" && (
                <Button
                  disabled={!attachable}
                  onClick={() =>
                    void props
                      .attachments!.check(upload.id)
                      .catch(() => setIssue("Upload is still unconfirmed."))
                  }
                >
                  Check upload
                </Button>
              )}
              {!upload.removed && (
                <Button
                  disabled={!attachable}
                  onClick={() => props.attachments!.clear(upload.id)}
                  aria-label={`Remove upload ${upload.name}`}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mpx-toolbar">
        <div className="mpx-control-slots">
          {props.attachments && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  addFiles([...(event.currentTarget.files ?? [])]);
                  event.currentTarget.value = "";
                }}
              />
              <Button
                disabled={!attachable || uploads.busy}
                onClick={() => picker.current?.click()}
              >
                Add files
              </Button>
            </>
          )}
          {props.controls?.(snapshot)}
          {props.advancedControls && (
            <Dialog title="Agent settings" trigger={<Button>Settings</Button>}>
              {props.advancedControls(snapshot)}
            </Dialog>
          )}
        </div>
        <div className="mpx-actions">
          {!props.readOnly && props.actions.stop && (
            <Button
              onClick={() => {
                try {
                  void view
                    .submit(props.actions.stop!(view.entry.getSnapshot()))
                    .catch(() => setIssue("Stop completion is unconfirmed. Check its original."));
                } catch {
                  setIssue("Stop was not admitted.");
                }
              }}
              disabled={snapshot.state?.phase === "stopped" || snapshot.state?.phase === "archived"}
            >
              Stop
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={
              props.readOnly ||
              !props.actions.draft ||
              sending ||
              attachmentBlocked ||
              (!snapshot.draft.trim() && !snapshot.attachments.length) ||
              snapshot.freshness !== "current" ||
              snapshot.state?.phase !== "running"
            }
          >
            {sending ? "Admitting…" : "Send"}
          </Button>
        </div>
      </div>
      {issue && (
        <p className="mpx-error" role="alert">
          {issue}
        </p>
      )}
    </form>
  );
}
export function Chat(props: ChatProps) {
  const { view } = props,
    { snapshot, intent, scrollerRef, contentRef } = useTranscriptViewport(view),
    [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const rows = snapshot.history.rows,
    current = snapshot.history.current,
    activeCompaction = rows.some(
      (row) => row.native.type === "contextCompaction" && rowInProgress(row, snapshot),
    );
  const { files: _files, media: _media, markdownFiles: _markdownFiles, ...withoutFiles } = props;
  const rowProps = {
    ...(snapshot.state?.phase === "archived" ? withoutFiles : props),
    actions: props.readOnly ? {} : props.actions,
  };
  return (
    <PortalScope.Provider value={portal}>
      <div
        ref={setPortal}
        className={`mpx-chat ${props.className ?? ""}`}
        data-theme={props.theme ?? "light"}
      >
        <header className="mpx-chat-header">
          <h2>{props.title ?? "Conversation"}</h2>
          <span role="status">
            {snapshot.freshness !== "current"
              ? "Connecting…"
              : snapshot.state?.phase === "stopped"
                ? "Stopped"
                : snapshot.state?.phase === "archived"
                  ? "Archived"
                  : snapshot.state?.phase === "running"
                    ? "Connected"
                    : (snapshot.state?.phase ?? "Unknown")}
          </span>
          <Button
            aria-pressed={snapshot.pinned}
            onClick={() => void view.entry.pin(!snapshot.pinned).catch(() => {})}
          >
            {snapshot.pinned ? "Unpin" : "Pin"}
          </Button>
        </header>
        <section
          className="mpx-transcript"
          ref={(element) => {
            scrollerRef.current = element;
          }}
          tabIndex={0}
          aria-label="Conversation history"
        >
          <div
            className="mpx-transcript-content"
            ref={(element) => {
              contentRef.current = element;
            }}
          >
            <HistoryBoundary key={scopeKey(snapshot.scope)} view={view} snapshot={snapshot} />
            {current?.gaps.some((gap) => gap.kind === "captureLost") && (
              <p className="mpx-warning" role="status">
                History capture was interrupted. Some messages may be missing.
              </p>
            )}
            {(snapshot.history.residencyOmitted || current?.gaps.length) && (
              <details className="mpx-coverage">
                <summary>History coverage</summary>
                {snapshot.history.residencyOmitted && (
                  <p>Some loaded ranges are outside this retained window.</p>
                )}
                <ul>
                  {current?.gaps.map((gap) => (
                    <li key={gap.id}>{gap.kind}</li>
                  ))}
                </ul>
              </details>
            )}
            {!rows.length && (
              <p className="mpx-empty">
                {snapshot.historyFreshness === "unobserved"
                  ? "History has not been observed"
                  : "No messages in this history window"}
              </p>
            )}
            {rows.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                snapshot={snapshot}
                props={rowProps}
                {...(!props.readOnly
                  ? {
                      onChoice: (text: string) => {
                        const draft = view.entry.getSnapshot().draft;
                        void view.entry
                          .setDraft(draft ? `${draft}\n${text}` : text)
                          .then(() =>
                            portal
                              ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
                              ?.focus({ preventScroll: true }),
                          )
                          .catch(() => {});
                      },
                    }
                  : {})}
              />
            ))}
            {snapshot.originals
              .filter(
                (original) =>
                  original.command.optimisticText !== undefined &&
                  !original.nativeConfirmed &&
                  !["refused", "localFailure"].includes(original.state),
              )
              .map((original) => (
                <article
                  className="mpx-row mpx-row--user"
                  data-history-row={`optimistic:${original.command.id}`}
                  key={original.command.id}
                >
                  <header>You</header>
                  <p>{original.command.optimisticText}</p>
                  <small>
                    {original.state === "unknown"
                      ? "Completion unconfirmed"
                      : "Awaiting native confirmation"}
                  </small>
                </article>
              ))}
            <Originals snapshot={snapshot} view={view} />
            {nativeWorking(snapshot) && !activeCompaction && (
              <p className="mpx-working" role="status">
                <span className="mpx-spinner" aria-hidden />
                Working…
              </p>
            )}
            <RequestArea
              key={JSON.stringify(snapshot.state?.run)}
              items={snapshot.interactions?.items ?? []}
              available={
                !props.readOnly &&
                snapshot.freshness === "current" &&
                snapshot.interactionsFreshness === "current" &&
                snapshot.interactions?.baseline === "complete"
              }
              actions={props.actions}
            />
          </div>
        </section>
        {intent.mode === "readingHistory" && (
          <Button className="mpx-jump" onClick={() => view.anchor.followLatest()}>
            Jump to latest
          </Button>
        )}
        <Composer key={scopeKey(snapshot.scope)} view={view} snapshot={snapshot} props={props} />
      </div>
    </PortalScope.Provider>
  );
}
function Originals({ snapshot, view }: Readonly<{ snapshot: EntrySnapshot; view: SessionView }>) {
  const uncertain = snapshot.originals.filter((value) => value.state === "unknown");
  return (
    <>
      {snapshot.persistenceIssue && (
        <p className="mpx-error" role="alert">
          Local persistence is unavailable.
        </p>
      )}
      {uncertain.map((value) => (
        <div className="mpx-original" key={value.command.id}>
          <span>Operation completion unconfirmed</span>
          <Button onClick={() => void view.entry.checkOriginal(value.command.id).catch(() => {})}>
            Check original
          </Button>
        </div>
      ))}
    </>
  );
}
function SessionListRow<View extends SessionListView>({
  item,
  selected,
  onSelect,
}: Readonly<{
  item: SessionListItem<View>;
  selected: boolean;
  onSelect(view: View): void;
}>) {
  const entry = item.view.entry;
  const store = useMemo(
    () => ({
      subscribe: entry.subscribe.bind(entry),
      getSnapshot: entry.getSnapshot.bind(entry),
    }),
    [entry],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <li>
      <Button aria-current={selected ? "page" : undefined} onClick={() => onSelect(item.view)}>
        <span>{item.name}</span>
        <span className="mpx-hint">
          {snapshot.freshness !== "current"
            ? "Unavailable"
            : snapshot.state?.phase === "running"
              ? snapshot.state.activity
              : (snapshot.state?.phase ?? "Unknown")}
          {snapshot.draft || snapshot.attachments.length ? " · Draft" : ""}
          {snapshot.pinned ? " · Pinned" : ""}
        </span>
      </Button>
    </li>
  );
}
export function SessionList<View extends SessionListView>({
  items,
  selected,
  onSelect,
}: SessionListProps<View>) {
  return (
    <nav className="mpx-session-list" aria-label="Conversations">
      <ul>
        {items.map((item) => (
          <SessionListRow
            key={item.key}
            item={item}
            selected={item.view === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  );
}

/** Standalone read-only transcript. A native child can supply this capability
 * directly; no root lifecycle, draft, Send or Stop is fabricated. */
export function ReadonlyTranscript(props: ReadonlyTranscriptProps) {
  const { snapshot, intent, scrollerRef, contentRef } = useReadonlyTranscriptViewport(props.view);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const { history } = snapshot;
  const activeCompaction = history.rows.some(
    (row) => row.native.type === "contextCompaction" && rowInProgress(row, snapshot),
  );
  const presentation = snapshot.retired ? { actions: {} } : { ...props, actions: {} };
  return (
    <PortalScope.Provider value={portal}>
      <div
        ref={setPortal}
        className={`mpx-chat ${props.className ?? ""}`}
        data-theme={props.theme ?? "light"}
      >
        <header className="mpx-chat-header">
          <h2>{props.title ?? "History"}</h2>
          <span role="status">
            {snapshot.retired
              ? "Earlier lifetime"
              : snapshot.freshness === "current"
                ? "Connected"
                : "Connecting…"}
          </span>
        </header>
        <section
          className="mpx-transcript"
          ref={(element) => {
            scrollerRef.current = element;
          }}
          tabIndex={0}
          aria-label="Conversation history"
        >
          <div
            className="mpx-transcript-content"
            ref={(element) => {
              contentRef.current = element;
            }}
          >
            <HistoryBoundary view={props.view} snapshot={snapshot} />
            {history.current?.gaps.some((gap) => gap.kind === "captureLost") && (
              <p className="mpx-warning" role="status">
                History capture was interrupted. Some messages may be missing.
              </p>
            )}
            {(history.residencyOmitted || !!history.current?.gaps.length) && (
              <details className="mpx-coverage">
                <summary>History coverage</summary>
                {history.residencyOmitted && (
                  <p>Some loaded ranges are outside this retained window.</p>
                )}
                <ul>
                  {history.current?.gaps.map((gap) => (
                    <li key={gap.id}>{gap.kind}</li>
                  ))}
                </ul>
              </details>
            )}
            {!history.rows.length && (
              <p className="mpx-empty">
                {snapshot.freshness === "unobserved"
                  ? "History has not been observed"
                  : "No messages in this history window"}
              </p>
            )}
            {history.rows.map((row) => (
              <HistoryRow key={row.id} row={row} snapshot={snapshot} props={presentation} />
            ))}
            {snapshot.working && !activeCompaction && (
              <p className="mpx-working" role="status">
                <span className="mpx-spinner" aria-hidden />
                Working…
              </p>
            )}
          </div>
        </section>
        {intent.mode === "readingHistory" && (
          <Button className="mpx-jump" onClick={() => props.view.anchor.followLatest()}>
            Jump to latest
          </Button>
        )}
      </div>
    </PortalScope.Provider>
  );
}
