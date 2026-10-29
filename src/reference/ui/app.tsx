import { useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EntrySnapshot, RetainedWorkspace, SessionView } from "../../client/index.js";
import { Chat, Field, Select, SessionList, ThemeScope } from "../../chat/index.js";

import type {
  ControlChoice,
  Conversation,
  ConversationDescriptor,
  ReferenceAppProps,
} from "./contracts.js";
/** Explicit preparation before mounting. The only retained conversation map is
 * RetainedWorkspace's; this array holds presentation descriptors/view anchors. */
export function prepareConversations(
  workspace: RetainedWorkspace,
  descriptors: readonly ConversationDescriptor[],
): readonly Conversation[] {
  if (
    descriptors.length > workspace.limits.maxEntries ||
    new Set(descriptors.map((value) => value.id)).size !== descriptors.length
  )
    throw new TypeError("Invalid reference conversations");
  return descriptors.map(({ scope, ...descriptor }) => ({
    ...descriptor,
    view: workspace.view(scope),
  }));
}
function Choice({ choice, view }: Readonly<{ choice: ControlChoice; view: SessionView }>) {
  const admitting = useRef(false),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(false);
  return (
    <div className="mpx-reference-choice" data-control={choice.id}>
      <Field
        label={choice.label}
        {...(issue
          ? { error: "Control was not locally admitted. Check the retained original if present." }
          : {})}
      >
        {(props) => (
          <Select
            {...props}
            value={choice.value}
            options={choice.options}
            disabled={choice.disabled || busy}
            onValueChange={(value) => {
              if (admitting.current) return;
              setIssue(false);
              try {
                const command = choice.prepare(value, view.entry.getSnapshot());
                admitting.current = true;
                setBusy(true);
                void view
                  .submit(command)
                  .catch(() => setIssue(true))
                  .finally(() => {
                    admitting.current = false;
                    setBusy(false);
                  });
              } catch {
                admitting.current = false;
                setBusy(false);
                setIssue(true);
              }
            }}
          />
        )}
      </Field>
    </div>
  );
}
function Controls({
  conversation,
  snapshot,
  advanced,
}: Readonly<{ conversation: Conversation; snapshot: EntrySnapshot; advanced: boolean }>) {
  return (
    <div className={advanced ? "mpx-reference-settings" : "mpx-reference-inline"}>
      {conversation
        .controls?.(snapshot)
        .filter((choice) => advanced || !choice.advanced)
        .map((choice) => (
          <Choice key={choice.id} choice={choice} view={conversation.view} />
        ))}
    </div>
  );
}
/** Navigation state only. Mounting Chat commits its real view lease; switching
 * leaves retained entries/pins/drafts/originals and each view's anchor intact. */
export function ReferenceApp({
  conversations,
  selected,
  theme = "light",
  title = "Agent Multiplex",
}: ReferenceAppProps) {
  const [selectedId, setSelectedId] = useState(selected ?? conversations[0]?.id ?? ""),
    current = conversations.find((value) => value.id === selectedId) ?? conversations[0];
  return (
    <ThemeScope theme={theme} className="mpx-reference-app">
      <div className="mpx-reference-layout">
        <aside className="mpx-reference-sidebar">
          <header>
            <h1>{title}</h1>
            <p>Conversations</p>
          </header>
          <SessionList
            items={conversations.map((value) => ({
              key: value.id,
              name: value.name,
              view: value.view,
            }))}
            selected={current?.view ?? null}
            onSelect={(view) => {
              const next = conversations.find((value) => value.view === view);
              if (next) setSelectedId(next.id);
            }}
          />
        </aside>
        <main className="mpx-reference-main">
          <div className="mpx-reference-mobile-nav">
            <Field label="Conversation">
              {(props) => (
                <Select
                  {...props}
                  value={current?.id ?? ""}
                  disabled={!conversations.length}
                  options={conversations.map((value) => ({ value: value.id, label: value.name }))}
                  onValueChange={setSelectedId}
                />
              )}
            </Field>
          </div>
          {current ? (
            <Chat
              {...current}
              theme={theme}
              title={current.name}
              controls={(snapshot) => (
                <Controls conversation={current} snapshot={snapshot} advanced={false} />
              )}
              {...(current.controls
                ? {
                    advancedControls: (snapshot: EntrySnapshot) => (
                      <Controls conversation={current} snapshot={snapshot} advanced />
                    ),
                  }
                : {})}
            />
          ) : (
            <ThemeScope theme={theme}>
              <p className="mpx-reference-empty">No conversations are available.</p>
            </ThemeScope>
          )}
        </main>
      </div>
    </ThemeScope>
  );
}
/** Explicit consumer boot, not module import. Cleanup first unmounts view
 * effects; the caller still owns workspace/feed/transport actual cleanup. */
export function mountReferenceApp(
  element: HTMLElement,
  props: ReferenceAppProps,
): Readonly<{ root: Root; close(): void }> {
  const root = createRoot(element);
  root.render(<ReferenceApp {...props} />);
  let closed = false;
  return {
    root,
    close() {
      if (!closed) {
        closed = true;
        root.unmount();
      }
    },
  };
}
