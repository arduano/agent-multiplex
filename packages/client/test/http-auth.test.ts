import { describe, expect, it } from "vitest";
import { initTRPC } from "@trpc/server";

import { createAccessClient } from "../src/client.js";
import {
  bearerAuthorization,
  bearerAuthorizationHeaders,
  bearerConnectionParams,
  createWebSocketTRPCClient,
} from "../src/http.js";

const testRouter = initTRPC.create().router({});

describe("HTTP/WebSocket bearer client helpers", () => {
  it("uses the standard Authorization shape in both transports", async () => {
    expect(bearerAuthorization("opaque-token.value")).toBe(
      "Bearer opaque-token.value",
    );
    await expect(
      bearerAuthorizationHeaders("opaque-token.value")(),
    ).resolves.toEqual({ authorization: "Bearer opaque-token.value" });
    await expect(
      bearerConnectionParams("opaque-token.value")(),
    ).resolves.toEqual({ authorization: "Bearer opaque-token.value" });
  });

  it("resolves providers afresh for requests and reconnects", async () => {
    let revision = 0;
    const provider = () => `rotating-token-${++revision}`;
    const headers = bearerAuthorizationHeaders(provider);
    const connectionParams = bearerConnectionParams(provider);

    await expect(headers()).resolves.toEqual({
      authorization: "Bearer rotating-token-1",
    });
    await expect(connectionParams()).resolves.toEqual({
      authorization: "Bearer rotating-token-2",
    });
  });

  it("rejects empty and whitespace-bearing tokens", () => {
    expect(() => bearerAuthorization("")).toThrow(/non-empty/);
    expect(() => bearerAuthorization("two tokens")).toThrow(/whitespace/);
  });

  it("refuses ambiguous custom and managed credentials", () => {
    expect(() =>
      createWebSocketTRPCClient<typeof testRouter>({
        url: "http://127.0.0.1:1/trpc",
        bearerToken: "managed-token",
        headers: { authorization: "Bearer custom-token" },
      }),
    ).toThrow(/custom headers/);
    expect(() =>
      createWebSocketTRPCClient<typeof testRouter>({
        url: "http://127.0.0.1:1/trpc",
        bearerToken: "managed-token",
        subscription: {
          connectionParams: { authorization: "Bearer custom-token" },
        },
      }),
    ).toThrow(/custom WebSocket connectionParams/);
    expect(() =>
      createAccessClient({
        httpUrl: "http://127.0.0.1:1/trpc",
        bearerToken: "managed-token",
        headers: () => ({ authorization: "Bearer custom-token" }),
      }),
    ).toThrow(/custom headers/);
  });
});
