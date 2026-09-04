import { describe, expect, it } from "vitest";

import {
  accessTokenFromHref,
  hrefWithAccessToken,
} from "../apps/web/src/client/url-auth.js";

describe("web prototype URL authentication", () => {
  it("reads and trims an encoded token from the client-only fragment", () => {
    expect(accessTokenFromHref("http://100.64.0.1:5173/#token=%20local%2Ftoken%2Bvalue%20"))
      .toBe("local/token+value");
    expect(accessTokenFromHref("not a URL")).toBe("");
  });

  it("does not treat query parameters as embedded credentials", () => {
    expect(accessTokenFromHref("http://100.64.0.1:5173/?token=query-secret"))
      .toBe("");
  });

  it("fails closed when the fragment supplies more than one token", () => {
    expect(accessTokenFromHref("http://100.64.0.1:5173/#token=first&token=second"))
      .toBe("");
  });

  it("creates a bookmarkable fragment without putting the token in the request URL", () => {
    const href = hrefWithAccessToken(
      "http://100.64.0.1:5173/workspace?view=fleet#panel=agents",
      "local/token+value",
    );
    const parsed = new URL(href);

    expect(parsed.origin + parsed.pathname + parsed.search)
      .toBe("http://100.64.0.1:5173/workspace?view=fleet");
    expect(parsed.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(parsed.hash.slice(1)).get("panel")).toBe("agents");
    expect(accessTokenFromHref(href)).toBe("local/token+value");
  });

  it("replaces and removes only the token fragment parameter", () => {
    const replaced = hrefWithAccessToken(
      "http://localhost:5173/#panel=session&token=old",
      "new",
    );
    expect(new URL(replaced).hash).toBe("#panel=session&token=new");
    expect(hrefWithAccessToken(replaced, "")).toBe(
      "http://localhost:5173/#panel=session",
    );
  });
});
