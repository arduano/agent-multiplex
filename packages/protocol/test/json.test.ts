import { canonicalProtocolRecordJson } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("canonical protocol record JSON", () => {
  it("treats explicit undefined object members as absent at every object depth", () => {
    expect(canonicalProtocolRecordJson({
      state: "preparing",
      result: undefined,
      nested: { error: undefined, retained: null },
    })).toBe(canonicalProtocolRecordJson({
      state: "preparing",
      nested: { retained: null },
    }));
  });

  it("does not normalize top-level or array-element undefined into JSON", () => {
    expect(() => canonicalProtocolRecordJson(undefined)).toThrow();
    expect(() => canonicalProtocolRecordJson(["accepted", undefined])).toThrow();
  });

  it("still rejects non-JSON object values", () => {
    expect(() => canonicalProtocolRecordJson({ timestamp: new Date(0) })).toThrow();
  });
});
