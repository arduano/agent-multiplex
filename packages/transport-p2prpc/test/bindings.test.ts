import {
  commandEnvelopeSchema,
  emptyMetadataSnapshot,
  metadataOperationRecordSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newCommandId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newOperationId,
  newRealmId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalId,
  type AccessStreamItem,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  childControlNodeConnectionFromPeer,
  childControlNodeConnectionFromPeerResolver,
  createControlNodeIngressContextFactory,
  subscriptionAsAsyncIterableForTesting,
} from "../src/bindings.js";

describe("child control-node p2prpc binding", () => {
  it("fences recursive calls and adapts the aggregate subscription", async () => {
    const binding = {
      controlNodeId: newControlNodeId(),
      controlNodeBootId: newControlNodeBootId(),
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    let callbacks: SubscriptionCallbacks | undefined;
    let terminalCallbacks: SubscriptionCallbacks | undefined;
    const unsubscribe = vi.fn();
    const snapshot = vi.fn().mockResolvedValue({ nextPageToken: null });
    const execute = vi.fn().mockResolvedValue({ state: "succeeded" });
    const applyMetadata = vi.fn().mockResolvedValue({ status: "accepted" });
    const subscribe = vi.fn((_input: unknown, next: SubscriptionCallbacks) => {
      callbacks = next;
      return { unsubscribe };
    });
    const terminalGet = vi.fn().mockResolvedValue(null);
    const terminalAttach = vi.fn((_input: unknown, next: SubscriptionCallbacks) => {
      terminalCallbacks = next;
      return { unsubscribe };
    });
    const peer = {
      identity: { id: "child-endpoint" },
      principal: { id: "child-principal" },
      rpc: {
        link: {
          topology: { snapshot: { query: snapshot } },
          events: { subscribe: { subscribe } },
          terminals: {
            get: { query: terminalGet },
            attach: { subscribe: terminalAttach },
          },
          commands: { execute: { mutate: execute } },
          metadata: { settle: { mutate: applyMetadata } },
        },
      },
    };
    const connection = childControlNodeConnectionFromPeer(
      peer as unknown as Parameters<typeof childControlNodeConnectionFromPeer>[0],
      binding,
    );

    await connection.readSubtreeSnapshot({
      attachmentId: binding.attachmentId,
      lineageId: binding.lineageId,
      pageToken: "next-page",
      limit: 25,
    });
    expect(snapshot).toHaveBeenCalledWith({
      ...binding,
      pageToken: "next-page",
      limit: 25,
    });

    const command = commandEnvelopeSchema.parse({
      commandId: newCommandId(),
      payloadHash: "a".repeat(64),
      sessionId: newSessionId(),
      runtimeNodeId: newRuntimeNodeId(),
      bindingRevision: 1,
      request: { harness: "codex", command: { type: "interrupt" } },
    });
    await connection.execute(command);
    expect(execute).toHaveBeenCalledWith({ ...binding, command });

    const now = new Date().toISOString();
    const operationId = newOperationId();
    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    const operation = metadataOperationRecordSchema.parse({
      operationId,
      sessionId: command.sessionId,
      patch: {
        operationId,
        sessionId: command.sessionId,
        expectedAuthority: authority,
        set: { "agent.title": "nested" },
      },
      status: "accepted",
      canonical: emptyMetadataSnapshot(),
      originControlNodeId: binding.controlNodeId,
      authority,
      createdAt: now,
      updatedAt: now,
    });
    await connection.applyMetadata?.(operation);
    expect(applyMetadata).toHaveBeenCalledWith({ ...binding, operation });

    const cursor = { feedId: newFeedId(), controlCursor: 7, native: {} };
    const iterator = connection.subscribeAggregate(cursor)[Symbol.asyncIterator]();
    expect(subscribe).toHaveBeenCalledWith(
      { ...binding, cursor },
      expect.any(Object),
    );
    const item: AccessStreamItem = {
      kind: "heartbeat",
      feedId: cursor.feedId,
      controlCursor: 8,
      authorityRefs: [authority],
    };
    callbacks?.onStarted?.();
    const pending = iterator.next();
    callbacks?.onData(item);
    await expect(pending).resolves.toEqual({ done: false, value: item });
    await iterator.return?.();
    expect(unsubscribe).toHaveBeenCalledOnce();

    const terminalRequest = {
      sessionId: command.sessionId,
      runtimeNodeId: command.runtimeNodeId,
      bindingRevision: command.bindingRevision,
    };
    await expect(connection.getTerminal?.(terminalRequest)).resolves.toBeNull();
    expect(terminalGet).toHaveBeenCalledWith({ ...binding, request: terminalRequest });
    const terminalId = newTerminalId();
    const terminalIterator = connection.attachTerminal?.({
      ...terminalRequest,
      terminalId,
    })[Symbol.asyncIterator]();
    expect(terminalAttach).toHaveBeenCalledWith(
      { ...binding, request: { ...terminalRequest, terminalId } },
      expect.any(Object),
    );
    terminalCallbacks?.onStarted?.();
    const terminalPending = terminalIterator!.next();
    terminalCallbacks?.onData({
      kind: "heartbeat",
      cursor: { terminalId, sequence: 0 },
    });
    await expect(terminalPending).resolves.toMatchObject({
      done: false,
      value: { kind: "heartbeat", cursor: { terminalId } },
    });
    await terminalIterator!.return?.();
  });

  it("defers an early unsubscribe until p2prpc dispatches it", async () => {
    const binding = {
      controlNodeId: newControlNodeId(),
      controlNodeBootId: newControlNodeBootId(),
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    let callbacks: SubscriptionCallbacks | undefined;
    const unsubscribe = vi.fn();
    const peer = {
      identity: { id: "child-endpoint" },
      principal: { id: "child-principal" },
      rpc: {
        link: {
          events: {
            subscribe: {
              subscribe: (_input: unknown, next: SubscriptionCallbacks) => {
                callbacks = next;
                return { unsubscribe };
              },
            },
          },
        },
      },
    };
    const connection = childControlNodeConnectionFromPeer(
      peer as unknown as Parameters<typeof childControlNodeConnectionFromPeer>[0],
      binding,
    );
    const iterator = connection.subscribeAggregate({
      feedId: newFeedId(),
      controlCursor: 0,
      native: {},
    })[Symbol.asyncIterator]();

    await iterator.return?.();
    expect(unsubscribe).not.toHaveBeenCalled();
    callbacks?.onStarted?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("does not open a subscription for an already-aborted request", async () => {
    const subscribe = vi.fn();
    const peer = {
      identity: { id: "child-endpoint" },
      principal: { id: "child-principal" },
      rpc: { link: { events: { subscribe: { subscribe } } } },
    };
    const connection = childControlNodeConnectionFromPeer(
      peer as unknown as Parameters<typeof childControlNodeConnectionFromPeer>[0],
      {
        controlNodeId: newControlNodeId(),
        controlNodeBootId: newControlNodeBootId(),
        attachmentId: newAttachmentId(),
        lineageId: newLineageId(),
      },
    );
    const controller = new AbortController();
    controller.abort();
    const iterator = connection.subscribeAggregate(
      { feedId: newFeedId(), controlCursor: 0, native: {} },
      controller.signal,
    )[Symbol.asyncIterator]();

    expect(subscribe).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("fails a stalled generic subscription when its bounded mailbox overflows", async () => {
    let callbacks: SubscriptionCallbacks | undefined;
    const unsubscribe = vi.fn();
    const cursor = { feedId: newFeedId(), controlCursor: 0, native: {} };
    const stream = subscriptionAsAsyncIterableForTesting<AccessStreamItem>(
      (_input, next) => {
        callbacks = next;
        return { unsubscribe };
      },
      cursor,
      undefined,
      1,
    );
    const iterator = stream[Symbol.asyncIterator]();
    callbacks?.onStarted?.();
    const item: AccessStreamItem = {
      kind: "heartbeat",
      feedId: cursor.feedId,
      controlCursor: 0,
      authorityRefs: [],
    };
    callbacks?.onData(item);
    callbacks?.onData(item);

    await expect(iterator.next()).rejects.toMatchObject({
      name: "SubscriptionBufferOverflowError",
      capacity: 1,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("resolves a newly assigned attachment fence lazily", async () => {
    const controlNodeId = newControlNodeId();
    const controlNodeBootId = newControlNodeBootId();
    let attachmentId = newAttachmentId();
    let lineageId = newLineageId();
    const models = vi.fn().mockResolvedValue([]);
    const peer = {
      identity: { id: "child-endpoint" },
      principal: { id: "child-principal" },
      rpc: { link: { harness: { models: { query: models } } } },
    };
    const connection = childControlNodeConnectionFromPeer(
      peer as unknown as Parameters<typeof childControlNodeConnectionFromPeer>[0],
      {
        controlNodeId,
        controlNodeBootId,
        currentFence: () => ({ attachmentId, lineageId }),
      },
    );

    const runtimeNodeId = newRuntimeNodeId();
    await connection.listModels(runtimeNodeId, "codex");
    expect(models).toHaveBeenLastCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      runtimeNodeId,
      harness: "codex",
    });

    attachmentId = newAttachmentId();
    lineageId = newLineageId();
    await connection.listModels(runtimeNodeId, "copilot");
    expect(models).toHaveBeenLastCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      runtimeNodeId,
      harness: "copilot",
    });
  });

  it("resolves a replacement authenticated peer for each recursive call and subscription", async () => {
    const endpointId = "child-endpoint";
    const binding = {
      controlNodeId: newControlNodeId(),
      controlNodeBootId: newControlNodeBootId(),
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
    };
    const firstModels = vi.fn().mockResolvedValue([{ id: "first" }]);
    const secondModels = vi.fn().mockResolvedValue([{ id: "second" }]);
    const firstSubscribe = vi.fn((_input: unknown, callbacks: SubscriptionCallbacks) => {
      callbacks.onStarted?.();
      return { unsubscribe() {} };
    });
    const secondSubscribe = vi.fn((_input: unknown, callbacks: SubscriptionCallbacks) => {
      callbacks.onStarted?.();
      return { unsubscribe() {} };
    });
    const peer = (
      id: string,
      models: typeof firstModels,
      subscribe: typeof firstSubscribe,
    ) => ({
      identity: { id },
      principal: { id: "child-principal" },
      rpc: {
        link: {
          harness: { models: { query: models } },
          events: { subscribe: { subscribe } },
        },
      },
    });
    let currentPeer = peer(endpointId, firstModels, firstSubscribe);
    const connection = childControlNodeConnectionFromPeerResolver(
      endpointId,
      () => currentPeer as never,
      binding,
      "child-principal",
    );
    const runtimeNodeId = newRuntimeNodeId();

    await expect(connection.listModels(runtimeNodeId, "codex")).resolves.toEqual([
      { id: "first" },
    ]);
    const firstIterator = connection.subscribeAggregate({
      feedId: newFeedId(),
      controlCursor: 0,
      native: {},
    })[Symbol.asyncIterator]();

    currentPeer = peer(endpointId, secondModels, secondSubscribe);
    await expect(connection.listModels(runtimeNodeId, "copilot")).resolves.toEqual([
      { id: "second" },
    ]);
    const secondIterator = connection.subscribeAggregate({
      feedId: newFeedId(),
      controlCursor: 0,
      native: {},
    })[Symbol.asyncIterator]();

    expect(firstModels).toHaveBeenCalledOnce();
    expect(secondModels).toHaveBeenCalledOnce();
    expect(firstSubscribe).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();
    await firstIterator.return?.();
    await secondIterator.return?.();

    currentPeer = peer("wrong-endpoint", secondModels, secondSubscribe);
    expect(() => connection.listModels(runtimeNodeId, "codex")).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

describe("control-node ingress reverse bindings", () => {
  it("keeps a runtime binding on its endpoint while following replacement peer epochs", async () => {
    const endpointId = "runtime-endpoint";
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const sessionId = newSessionId();
    const firstHistory = vi.fn().mockResolvedValue({
      harness: "codex",
      vendorSessionId: "native-session",
      payload: { epoch: "first" },
      complete: true,
    });
    const secondHistory = vi.fn().mockResolvedValue({
      harness: "codex",
      vendorSessionId: "native-session",
      payload: { epoch: "second" },
      complete: true,
    });
    const peer = (
      id: string,
      history: typeof firstHistory,
      principalId = endpointId,
    ) => ({
      identity: { id },
      principal: { id: principalId },
      rpc: { sessions: { readNativeHistory: { query: history } } },
    });
    let currentPeer: ReturnType<typeof peer> | undefined = peer(
      endpointId,
      firstHistory,
    );
    const factory = createControlNodeIngressContextFactory({
      getRuntimeNodePeer: (requestedEndpointId) => {
        expect(requestedEndpointId).toBe(endpointId);
        return currentPeer as never;
      },
      runtimeNodeIdForEndpoint: () => runtimeNodeId,
    });
    const context = factory({
      p2p: {
        peer: { id: endpointId },
        auth: { principal: { id: endpointId } },
      },
    } as never);
    const connection = context.createRuntimeNodeConnection?.(
      runtimeNodeId,
      runtimeNodeBootId,
    );
    expect(connection).toBeDefined();
    const request = { harness: "codex" as const, includeTurns: true };

    await expect(
      connection!.readNativeHistory(sessionId, request),
    ).resolves.toMatchObject({ payload: { epoch: "first" } });
    currentPeer = peer(endpointId, secondHistory);
    await expect(
      connection!.readNativeHistory(sessionId, request),
    ).resolves.toMatchObject({ payload: { epoch: "second" } });

    expect(firstHistory).toHaveBeenCalledWith({
      runtimeNodeBootId,
      sessionId,
      request,
    });
    expect(secondHistory).toHaveBeenCalledWith({
      runtimeNodeBootId,
      sessionId,
      request,
    });

    currentPeer = undefined;
    expect(() => connection!.readNativeHistory(sessionId, request)).toThrowError(
      expect.objectContaining({ code: "DISCONNECTED" }),
    );
    currentPeer = peer("wrong-endpoint", secondHistory);
    expect(() => connection!.readNativeHistory(sessionId, request)).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    currentPeer = peer(endpointId, secondHistory, "wrong-principal");
    expect(() => connection!.readNativeHistory(sessionId, request)).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("creates a child binding that follows peer replacement without weakening its fence", async () => {
    const endpointId = "child-endpoint";
    const controlNodeId = newControlNodeId();
    const controlNodeBootId = newControlNodeBootId();
    const attachmentId = newAttachmentId();
    const lineageId = newLineageId();
    const firstModels = vi.fn().mockResolvedValue([]);
    const secondModels = vi.fn().mockResolvedValue([]);
    const peer = (models: typeof firstModels) => ({
      identity: { id: endpointId },
      principal: { id: endpointId },
      rpc: { link: { harness: { models: { query: models } } } },
    });
    let currentPeer = peer(firstModels);
    const factory = createControlNodeIngressContextFactory({
      getRuntimeNodePeer: () => undefined,
      getChildControlNodePeer: () => currentPeer as never,
      controlNodeIdForEndpoint: () => controlNodeId,
      childControlNodeFence: (requestedControlNodeId) => {
        expect(requestedControlNodeId).toBe(controlNodeId);
        return { attachmentId, lineageId };
      },
    });
    const context = factory({
      p2p: {
        peer: { id: endpointId },
        auth: { principal: { id: endpointId } },
      },
    } as never);
    const connection = context.createChildControlNodeConnection?.({
      controlNodeId,
      controlNodeBootId,
    } as never);
    const runtimeNodeId = newRuntimeNodeId();

    await connection!.listModels(runtimeNodeId, "codex");
    currentPeer = peer(secondModels);
    await connection!.listModels(runtimeNodeId, "copilot");

    expect(firstModels).toHaveBeenCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      runtimeNodeId,
      harness: "codex",
    });
    expect(secondModels).toHaveBeenCalledWith({
      controlNodeId,
      controlNodeBootId,
      attachmentId,
      lineageId,
      runtimeNodeId,
      harness: "copilot",
    });
  });
});

interface SubscriptionCallbacks {
  onStarted?(): void;
  onData(value: AccessStreamItem): void;
  onError(error: unknown): void;
  onComplete(): void;
}
