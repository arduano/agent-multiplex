import { describe, expect, it } from "vitest";

import { isCanonicalUtcTimestamp } from "../scripts/canonical-utc-timestamp.mjs";

describe("native qualification timestamps", () => {
  it.each([
    "2026-09-04T20:27:14Z",
    "2026-09-04T20:27:14.4Z",
    "2026-09-04T20:27:14.43Z",
    "2026-09-04T20:27:14.436Z",
    "2026-09-04T20:27:14.4362Z",
    "2026-09-04T20:27:14.43620Z",
    "2026-09-04T20:27:14.436209Z",
    "2026-09-04T20:27:14.4362099Z",
    "2026-09-04T20:27:14.43620999Z",
    "2026-09-04T20:27:14.436209990Z",
  ])("accepts UTC timestamps with RFC3339Nano precision: %s", (value) => {
    expect(isCanonicalUtcTimestamp(value)).toBe(true);
  });

  it.each([
    null,
    0,
    "2026-09-04 20:27:14Z",
    "2026-09-04T20:27:14+00:00",
    "2026-09-04T20:27:14.Z",
    "2026-09-04T20:27:14.4362099900Z",
    "2026-02-30T20:27:14Z",
    "2026-09-04T24:00:00Z",
  ])("rejects non-canonical or invalid timestamps: %s", (value) => {
    expect(isCanonicalUtcTimestamp(value)).toBe(false);
  });
});
