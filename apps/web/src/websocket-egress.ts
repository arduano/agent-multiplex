/**
 * Default process-memory ceiling for application data queued to one tRPC
 * WebSocket observer. This is comfortably larger than the maximum encoded
 * terminal screen reset while remaining a small, fixed per-client bound.
 */
export const WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES = 8 * 1_024 * 1_024;

/** Maximum complete tRPC message accepted from one WebSocket peer. */
export const WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES = 8 * 1_024 * 1_024;

/** Maximum request body accepted by the maintained tRPC HTTP surfaces. */
export const TRPC_HTTP_BODY_LIMIT_BYTES = 8 * 1_024 * 1_024;

// RFC 6455 permits at most fourteen framing bytes around one message.
const MAXIMUM_WEBSOCKET_FRAME_OVERHEAD_BYTES = 14;
const WEBSOCKET_OPEN = 1;

type OpaqueSend = (...arguments_: never[]) => unknown;

interface BoundedEgressSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send: OpaqueSend;
  terminate(): void;
  once(event: "close", listener: () => void): unknown;
}

interface BoundedEgressServer<TSocket extends BoundedEgressSocket> {
  on(event: "connection", listener: (client: TSocket) => void): unknown;
}

/**
 * Guard a `ws` server before installing tRPC's WebSocket handler.
 *
 * The stock tRPC handler synchronously calls `send()` for every subscription
 * item. `ws` otherwise accepts those writes into an unbounded byte queue. This
 * guard accounts for the current queue and next complete frame, then terminates
 * the individual observer before an over-limit frame can be enqueued.
 */
export function installBoundedWebSocketEgress<
  TSocket extends BoundedEgressSocket,
>(webSockets: BoundedEgressServer<TSocket>): void {
  webSockets.on("connection", (client) => {
    const originalSend = client.send.bind(client) as unknown as (
      data: unknown,
      ...arguments_: unknown[]
    ) => void;
    let writable = true;
    client.once("close", () => {
      writable = false;
    });

    client.send = ((data: unknown, ...arguments_: unknown[]): void => {
      if (!writable || client.readyState !== WEBSOCKET_OPEN) {
        rejectSendCallback(
          arguments_,
          new Error("WebSocket is no longer writable"),
        );
        return;
      }

      const bufferedBytes = client.bufferedAmount;
      const payloadBytes = webSocketPayloadByteLength(data);
      const availableBytes = WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES -
        MAXIMUM_WEBSOCKET_FRAME_OVERHEAD_BYTES - bufferedBytes;
      if (
        payloadBytes === null ||
        !Number.isSafeInteger(bufferedBytes) ||
        bufferedBytes < 0 ||
        payloadBytes > availableBytes
      ) {
        writable = false;
        client.terminate();
        rejectSendCallback(
          arguments_,
          new Error(
            `WebSocket egress buffer exceeded ${WEBSOCKET_EGRESS_BUFFER_LIMIT_BYTES} bytes`,
          ),
        );
        return;
      }

      originalSend(data, ...arguments_);
    }) as OpaqueSend;
  });
}

function webSocketPayloadByteLength(data: unknown): number | null {
  try {
    if (typeof data === "string") return Buffer.byteLength(data, "utf8");
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
      return data.byteLength;
    }
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (Array.isArray(data)) {
      // `ws.Data` includes Buffer[]. Buffer.from(Buffer[]) coerces each Buffer
      // to one number and therefore measures the number of fragments rather
      // than their bytes. Sum every fragment explicitly and fail closed for a
      // non-view or unsafe total.
      let total = 0;
      for (const fragment of data) {
        if (!ArrayBuffer.isView(fragment)) return null;
        total += fragment.byteLength;
        if (!Number.isSafeInteger(total)) return null;
      }
      return total;
    }
    return null;
  } catch {
    return null;
  }
}

function rejectSendCallback(arguments_: readonly unknown[], error: Error): void {
  const callback = typeof arguments_[0] === "function"
    ? arguments_[0]
    : typeof arguments_[1] === "function"
      ? arguments_[1]
      : undefined;
  if (callback !== undefined) {
    process.nextTick(callback as (error: Error) => void, error);
  }
}
