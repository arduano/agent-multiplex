import { CopilotSession, type MessageOptions } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

// Exercise the installed pinned SDK's serialization/dispatch against an inert
// connection. No client, native process, auth home, network, or model is opened.
interface SdkProbe {
  send(options: MessageOptions): Promise<string>;
  rpc: { ui: Record<string, unknown>; tasks: Record<string, unknown> };
  registerElicitationHandler(handler: (context: unknown) => Promise<unknown>): void;
  _dispatchEvent(event: unknown): void;
}
const ProbeSession = CopilotSession as unknown as new (
  id: string, connection: { sendRequest(method: string, params: unknown): Promise<unknown> },
) => SdkProbe;

describe("pinned Copilot SDK lifecycle limitations (no native process)", () => {
  it("does not forward a caller causal/message ID through session.send", async () => {
    const sendRequest = vi.fn(async () => ({ messageId: "native-assigned" }));
    const session = new ProbeSession("disposable", { sendRequest });
    const options = { prompt: "synthetic fixture", mode: "enqueue" as const,
      operationId: "multiplex-command", messageId: "caller-message", causalOperationId: "causal" };
    await expect(session.send(options)).resolves.toBe("native-assigned");
    expect(sendRequest).toHaveBeenCalledOnce();
    const [method, wire] = sendRequest.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe("session.send");
    expect(wire).toMatchObject({ sessionId: "disposable", prompt: "synthetic fixture", mode: "enqueue" });
    for (const key of ["operationId", "messageId", "causalOperationId"]) expect(wire).not.toHaveProperty(key);
  });

  it("offers exact UI response RPCs but no pending UI snapshot or atomic task snapshot cursor", () => {
    const session = new ProbeSession("disposable", { sendRequest: async () => ({}) });
    for (const method of ["handlePendingUserInput", "handlePendingElicitation", "handlePendingExitPlanMode"]) {
      expect(session.rpc.ui[method]).toBeTypeOf("function");
    }
    expect(Object.keys(session.rpc.ui).filter(name => /list|pendingRequests|snapshot/i.test(name))).toEqual([]);
    expect(session.rpc.tasks.list).toBeTypeOf("function");
    expect(Object.keys(session.rpc.tasks).filter(name => /snapshot|cursor|watch/i.test(name))).toEqual([]);
  });

  it("strips elicitation request identity before callback and sends the answer outside its promise", async () => {
    const sendRequest = vi.fn(async () => ({ success: true }));
    const session = new ProbeSession("disposable", { sendRequest });
    const handler = vi.fn(async (_context: unknown) => ({ action: "cancel" }));
    session.registerElicitationHandler(handler);
    session._dispatchEvent({ type: "elicitation.requested", id: "event-uuid", ephemeral: true,
      data: { requestId: "exact-request", message: "Synthetic form", requestedSchema: { type: "object", properties: {} } } });
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ sessionId: "disposable", message: "Synthetic form" });
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("requestId");
    expect(sendRequest).toHaveBeenCalledWith("session.ui.handlePendingElicitation", {
      sessionId: "disposable", requestId: "exact-request", result: { action: "cancel" },
    });
  });
});
