import { describe, expect, it } from "vitest";

import { assertReviewedKoffiLock, readJson, reviewedKoffi } from "../scripts/release-config.mjs";

describe("reviewed koffi release closure", () => {
  it("matches the reviewed root lock and accepts an absent optional edge", () => {
    const root = readJson("package-lock.json").packages["node_modules/koffi"];
    expect({ version: root.version, integrity: root.integrity }).toEqual(reviewedKoffi);
    expect(() => assertReviewedKoffiLock({ packages: {} })).not.toThrow();
  });

  it("rejects newer or altered koffi in isolated consumers, including nested copies", () => {
    const lock = { packages: { "node_modules/koffi": { ...reviewedKoffi } } };
    expect(() => assertReviewedKoffiLock(lock)).not.toThrow();
    lock.packages["node_modules/koffi"].version = "3.3.2";
    expect(() => assertReviewedKoffiLock(lock)).toThrow(/koffi differs/);
    lock.packages["node_modules/koffi"].version = reviewedKoffi.version;
    lock.packages["node_modules/koffi"].integrity = "sha512-unreviewed";
    expect(() => assertReviewedKoffiLock(lock)).toThrow(/koffi differs/);
    const nested = { packages: { "node_modules/other/node_modules/koffi": { version: "3.3.2", integrity: reviewedKoffi.integrity } } };
    expect(() => assertReviewedKoffiLock(nested)).toThrow(/koffi differs/);
  });
});
