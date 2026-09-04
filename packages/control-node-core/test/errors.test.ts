import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { asTrpcError } from "../src/errors.js";

describe("control-node dependency error envelopes", () => {
  it("forwards allowlisted availability semantics without remote text or data", () => {
    const secret = "private child endpoint and transport details";
    const result = asTrpcError(remoteError(
      "SERVICE_UNAVAILABLE",
      secret,
    ));

    expect(result).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "control node dependency is unavailable",
    });
    expect(result.message).not.toContain(secret);
  });

  it("keeps BAD_GATEWAY stronger than a nested transient transport cause", () => {
    const disconnected = Object.assign(new Error("private disconnect"), {
      code: "DISCONNECTED",
    });
    const result = asTrpcError(remoteError(
      "BAD_GATEWAY",
      "private child ambiguity",
      disconnected,
    ));

    expect(result).toMatchObject({
      code: "BAD_GATEWAY",
      message: "control node dependency returned an indeterminate outcome",
    });
  });

  it("does not trust arbitrary error-shaped values as remote envelopes", () => {
    const secret = "private forged message";
    const forged = Object.assign(new Error(secret), {
      data: { code: "SERVICE_UNAVAILABLE", privateDetail: secret },
    });
    const result = asTrpcError(forged);

    expect(result).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "control node failed",
    });
    expect(result.message).not.toContain(secret);
  });
});

function remoteError(
  code: string,
  message: string,
  cause?: Error,
): TRPCClientError<never> {
  const data = Object.freeze({
    code,
    httpStatus: code === "SERVICE_UNAVAILABLE" ? 503 : 502,
    path: "sessions.readNativeHistory",
  });
  return new TRPCClientError(message, {
    result: {
      error: Object.freeze({
        message,
        code: -32603,
        data,
      }),
    },
    cause,
  } as never);
}
