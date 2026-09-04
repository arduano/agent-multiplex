import { describe, expect, it } from "vitest";

import {
  styleNonceForDocument,
  withSynchronousStyleNonce,
} from "../apps/web/src/client/style-nonce.js";

describe("web runtime stylesheet nonces", () => {
  it("nonces synchronously created styles without touching other elements", () => {
    const target = fakeDocument("valid-style-nonce-1234");
    const original = target.document.createElement;

    const result = withSynchronousStyleNonce(target.document, "valid-style-nonce-1234", () => {
      target.document.createElement("style");
      target.document.createElement("STYLE");
      target.document.createElement("div");
      return "initialized";
    });

    expect(result).toBe("initialized");
    expect(target.document.createElement).toBe(original);
    expect(target.created).toEqual([
      { tagName: "style", nonce: "valid-style-nonce-1234" },
      { tagName: "STYLE", nonce: "valid-style-nonce-1234" },
      { tagName: "div", nonce: undefined },
    ]);
  });

  it("restores an inherited createElement method when initialization throws", () => {
    const target = fakeDocument("valid-style-nonce-1234", true);
    const original = target.document.createElement;

    expect(() => withSynchronousStyleNonce(
      target.document,
      "valid-style-nonce-1234",
      () => {
        target.document.createElement("style");
        throw new Error("initialization failed");
      },
    )).toThrow("initialization failed");

    expect(Object.hasOwn(target.document, "createElement")).toBe(false);
    expect(target.document.createElement).toBe(original);
  });

  it("accepts only the server nonce shape exposed by inert metadata", () => {
    expect(styleNonceForDocument(fakeDocument("valid-style-nonce-1234").document))
      .toBe("valid-style-nonce-1234");
    expect(styleNonceForDocument(fakeDocument("bad nonce").document)).toBeUndefined();
    expect(styleNonceForDocument(fakeDocument(undefined).document)).toBeUndefined();
  });
});

function fakeDocument(nonce: string | undefined, inherited = false): {
  readonly document: Document;
  readonly created: Array<{ tagName: string; nonce?: string }>;
} {
  const created: Array<{ tagName: string; nonce?: string }> = [];
  const createElement = (tagName: string) => {
    const record: { tagName: string; nonce?: string } = { tagName };
    created.push(record);
    return {
      setAttribute(name: string, value: string) {
        if (name === "nonce") record.nonce = value;
      },
    };
  };
  const prototype = inherited ? { createElement } : null;
  const document = Object.assign(Object.create(prototype), {
    ...(inherited ? {} : { createElement }),
    querySelector: () => nonce === undefined ? null : { content: nonce },
  }) as unknown as Document;
  return { document, created };
}
