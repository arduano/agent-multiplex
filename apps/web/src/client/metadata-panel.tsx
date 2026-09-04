import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Braces, Check, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  metadataValuesSchema,
  newOperationId,
  type MetadataSnapshot,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";

import { errorMessage, useApi } from "./api.js";
import { Badge, Button, EmptyState, Textarea } from "./ui.js";

interface MetadataDraft {
  readonly text: string;
  readonly base: MetadataSnapshot;
}

export function MetadataPanel({ session }: { readonly session: SessionRecord | null }) {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const metadata = useQuery({
    queryKey: ["metadata", connectionKey, session?.sessionId],
    enabled: Boolean(session),
    queryFn: () => client.metadata.get.query(session!.sessionId),
  });
  const snapshot = metadata.data ?? session?.metadata;
  const canonicalText = useMemo(
    () => JSON.stringify(snapshot?.values ?? {}, null, 2),
    [snapshot?.revision, snapshot?.values],
  );
  const [text, setText] = useState("{}");
  const [dirty, setDirty] = useState(false);
  const [editBase, setEditBase] = useState<MetadataSnapshot | null>(null);
  const [status, setStatus] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const drafts = useRef(new Map<string, MetadataDraft>());
  const previousSessionId = useRef<string | null>(null);
  const [retainedDraftCount, setRetainedDraftCount] = useState(0);

  const validationError = useMemo(() => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (cause) {
      return `Invalid JSON: ${errorMessage(cause)}`;
    }
    const result = metadataValuesSchema.safeParse(decoded);
    if (result.success) return "";
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return `${issue?.message ?? "Metadata must be a JSON object"}${location}`;
  }, [text]);
  const canonicalAdvanced = Boolean(
    dirty && editBase && snapshot && snapshot.revision !== editBase.revision,
  );

  useEffect(() => {
    if (!dirty) setText(canonicalText);
  }, [canonicalText, dirty, session?.sessionId]);

  useEffect(() => {
    const previous = previousSessionId.current;
    if (previous && dirty && editBase) {
      drafts.current.set(previous, { text, base: editBase });
    }

    const next = session?.sessionId ?? null;
    previousSessionId.current = next;
    const draft = next ? drafts.current.get(next) : undefined;
    setDirty(Boolean(draft));
    setEditBase(draft?.base ?? null);
    setStatus(draft ? "Restored an unsaved draft from this browser" : "");
    setResetOpen(false);
    setText(draft?.text ?? canonicalText);
    setRetainedDraftCount(drafts.current.size);
  }, [session?.sessionId]);

  useEffect(() => {
    if (!dirty && retainedDraftCount === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, retainedDraftCount]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!session || !snapshot) throw new Error("Select a session first");
      const base = editBase ?? snapshot;
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch (cause) {
        throw new Error(`Metadata must be valid JSON: ${errorMessage(cause)}`);
      }
      const next = metadataValuesSchema.parse(decoded);
      const set = Object.fromEntries(
        Object.entries(next).filter(([key, value]) =>
          !Object.hasOwn(base.values, key) ||
          JSON.stringify(base.values[key]) !== JSON.stringify(value),
        ),
      );
      const remove = Object.keys(base.values).filter((key) => !Object.hasOwn(next, key));
      const touched = [...Object.keys(set), ...remove];
      if (touched.length === 0) throw new Error("No metadata changes to save");
      const ifKeyRevision = Object.fromEntries(
        touched.map((key) => [key, base.keyRevisions[key] ?? null]),
      );
      const operation = await client.metadata.patch.mutate({
        operationId: newOperationId(),
        sessionId: session.sessionId,
        expectedAuthority: session.metadataAuthority,
        ...(Object.keys(set).length ? { set } : {}),
        ...(remove.length ? { remove } : {}),
        ifKeyRevision,
      });
      return {
        operation,
        sessionId: session.sessionId,
        draft: { text, base } satisfies MetadataDraft,
      };
    },
    onSuccess: ({ operation, sessionId: savedSessionId, draft }) => {
      const projected = operation.optimistic ?? operation.canonical;
      const settled = operation.status === "accepted" || operation.status === "queued";
      if (settled) drafts.current.delete(savedSessionId);
      else drafts.current.set(savedSessionId, draft);
      setRetainedDraftCount(drafts.current.size);
      if (previousSessionId.current === savedSessionId) {
        if (settled) {
          setText(JSON.stringify(projected.values, null, 2));
          setDirty(false);
          setEditBase(null);
        }
        setStatus(
          operation.status === "accepted"
            ? `Saved revision ${operation.canonical.revision}`
            : operation.status === "queued"
              ? "Queued at the control node; awaiting authority settlement"
              : operation.status === "conflicted"
                ? "Conflict: reload canonical metadata before editing again"
                : "Outcome unknown; inspect the operation before trying again",
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["metadata"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => setStatus(errorMessage(error)),
  });

  if (!session) {
    return <EmptyState icon={Braces} title="No metadata selected" body="Choose a session to inspect its canonical key/value document." />;
  }

  return (
    <div className="grid min-h-0 gap-4 p-4" data-testid="metadata-editor">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Session metadata</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">Namespaced keys with JSON values.</p>
        </div>
        <Badge tone="brand">revision {snapshot?.revision ?? "…"}</Badge>
      </div>
      <Textarea
        className="min-h-80 resize-y overflow-auto whitespace-pre font-mono text-xs leading-5 [tab-size:2]"
        value={text}
        wrap="off"
        spellCheck={false}
        aria-invalid={Boolean(validationError)}
        aria-describedby="metadata-validation metadata-status"
        onChange={(event) => {
          const nextText = event.target.value;
          const nextDirty = nextText !== canonicalText;
          if (nextDirty && !dirty) setEditBase(snapshot ?? null);
          if (!nextDirty) {
            drafts.current.delete(session.sessionId);
            setRetainedDraftCount(drafts.current.size);
            setEditBase(null);
          }
          setText(nextText);
          setDirty(nextDirty);
          setResetOpen(false);
          setStatus("");
        }}
        aria-label="Metadata JSON"
        data-testid="metadata-json"
      />
      <div className="min-h-5" id="metadata-validation" aria-live="polite">
        {validationError ? (
          <p className="text-xs text-[var(--status-error)]">{validationError}</p>
        ) : canonicalAdvanced ? (
          <p className="text-xs text-[var(--status-waiting)]">
            Canonical metadata changed while you were editing. Save will use your original key revisions and report any conflicts.
          </p>
        ) : dirty ? (
          <p className="text-xs text-[var(--text-muted)]">Unsaved changes</p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <p className="min-h-5 break-words text-xs leading-5 text-[var(--text-secondary)]" id="metadata-status" role="status" data-testid="metadata-status">
          {metadata.isError ? `Could not load metadata: ${errorMessage(metadata.error)}` : status}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <DialogPrimitive.Root open={resetOpen} onOpenChange={setResetOpen}>
            <DialogPrimitive.Trigger asChild>
              <Button
                icon={RotateCcw}
                disabled={!dirty || mutation.isPending}
                data-testid="metadata-reset"
              >
                Reset
              </Button>
            </DialogPrimitive.Trigger>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]" />
              <DialogPrimitive.Content
                className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-shell)] p-5 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                aria-describedby="metadata-reset-description"
                data-testid="metadata-reset-dialog"
              >
                <DialogPrimitive.Title className="text-base font-semibold text-[var(--text-primary)]">
                  Discard this metadata draft?
                </DialogPrimitive.Title>
                <DialogPrimitive.Description id="metadata-reset-description" className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  Your unsaved changes for this session will be replaced with the latest canonical values.
                </DialogPrimitive.Description>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <DialogPrimitive.Close asChild>
                    <Button>Keep editing</Button>
                  </DialogPrimitive.Close>
                  <Button
                    tone="danger"
                    onClick={() => {
                      drafts.current.delete(session.sessionId);
                      setRetainedDraftCount(drafts.current.size);
                      setText(canonicalText);
                      setDirty(false);
                      setEditBase(null);
                      setResetOpen(false);
                      setStatus("Restored canonical values");
                    }}
                    data-testid="metadata-reset-confirm"
                  >
                    Discard draft
                  </Button>
                </div>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
          <Button
            tone="primary"
            icon={mutation.isSuccess && !dirty ? Check : Save}
            disabled={!dirty || Boolean(validationError) || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="metadata-save"
          >
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
