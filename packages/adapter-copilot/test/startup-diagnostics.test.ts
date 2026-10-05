import { describe, expect, it } from "vitest";
import { startupCauses } from "../src/startup-diagnostics.js";

describe("bounded private Copilot startup causes", () => {
  it("retains known native codes and nested cause classes without exception text", () => {
    const native = Object.assign(new Error("mock provider/configuration diagnostic"), { name: "ResponseError", code: -32603 });
    const outer = Object.assign(new Error("mock wrapper", { cause: native }), { code: "EPIPE" });
    expect(startupCauses(outer)).toEqual([{ name: "Error", code: "EPIPE" }, { name: "ResponseError", code: -32603 }]);
    expect(JSON.stringify(startupCauses(outer))).not.toContain(native.message);
  });

  it("never records arbitrary error names, codes or non-error values", () => {
    const error = Object.assign(new Error("mock only"), { name: "mock-private-name", code: "mock-private-code", cause: "mock-private-cause" });
    expect(startupCauses(error)).toEqual([{ name: "other" }, { name: "other" }]);
    expect(startupCauses(Object.assign(new Error(), { code: 99_999 }))).toEqual([{ name: "Error" }]);
  });

  it("bounds chained and circular causes and ignores hostile diagnostic getters", () => {
    let error = new Error("mock leaf");
    for (let i = 0; i < 10; i++) error = new Error("mock wrapper", { cause: error });
    expect(startupCauses(error)).toHaveLength(4);
    const cyclic = new Error("mock cyclic"); cyclic.cause = cyclic;
    expect(startupCauses(cyclic)).toEqual([{ name: "Error" }]);
    const getter = new Error("mock getter"); Object.defineProperty(getter, "code", { get() { throw new Error("mock unsafe getter"); } });
    expect(startupCauses(getter)).toEqual([{ name: "other" }]);
  });
});
