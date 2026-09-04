import { describe, expect, it } from "vitest";

import { nativeStreamSummaryPassed } from "../scripts/native-stream-evidence.mjs";

describe("native qualification replay evidence", () => {
  it("accepts identical replay across reset boundaries", () => {
    expect(nativeStreamSummaryPassed(summary(), 640)).toBe(true);
  });

  it.each([
    ["raw count mismatch", { rawNativeEventCount: 639 }],
    ["zero unique events", { uniqueNativeEventCount: 0, replayCount: 640 }],
    ["impossible unique count", { uniqueNativeEventCount: 641, replayCount: 0 }],
    ["replay arithmetic mismatch", { replayCount: 259 }],
    ["same-segment replay", { crossSegmentReplayCount: 259 }],
    ["no replay", { uniqueNativeEventCount: 640, replayCount: 0, crossSegmentReplayCount: 0 }],
    ["no reset", { streamResetCount: 0 }],
    ["missing segment", { segments: summary().segments.slice(0, 2) }],
    ["wrong segment index", { segments: [
      { segmentIndex: 1, nativeEventCount: 260, sequenceGroupCount: 2 },
      { segmentIndex: 1, nativeEventCount: 0, sequenceGroupCount: 0 },
      { segmentIndex: 2, nativeEventCount: 380, sequenceGroupCount: 2 },
    ] }],
    ["segment total mismatch", { segments: [
      { segmentIndex: 0, nativeEventCount: 259, sequenceGroupCount: 2 },
      { segmentIndex: 1, nativeEventCount: 0, sequenceGroupCount: 0 },
      { segmentIndex: 2, nativeEventCount: 380, sequenceGroupCount: 2 },
    ] }],
    ["empty segment with groups", { segments: [
      { segmentIndex: 0, nativeEventCount: 260, sequenceGroupCount: 2 },
      { segmentIndex: 1, nativeEventCount: 0, sequenceGroupCount: 1 },
      { segmentIndex: 2, nativeEventCount: 380, sequenceGroupCount: 2 },
    ] }],
    ["within-segment duplicate", { withinSegmentDuplicateKeys: ["duplicate"] }],
    ["conflicting replay", { conflictingReplays: ["conflict"] }],
    ["sequence gap", { noncontiguousGroups: [{ expected: 1, actual: 2 }] }],
  ])("rejects %s", (_label, override) => {
    expect(nativeStreamSummaryPassed({ ...summary(), ...override }, 640)).toBe(false);
  });

  it.each([null, {}, summary({ rawNativeEventCount: 0.5 })])(
    "rejects malformed evidence: %j",
    (value) => {
      expect(nativeStreamSummaryPassed(value, 640)).toBe(false);
    },
  );
});

function summary(overrides: Record<string, unknown> = {}) {
  return {
    rawNativeEventCount: 640,
    uniqueNativeEventCount: 380,
    replayCount: 260,
    crossSegmentReplayCount: 260,
    streamResetCount: 2,
    segments: [
      { segmentIndex: 0, nativeEventCount: 260, sequenceGroupCount: 2 },
      { segmentIndex: 1, nativeEventCount: 0, sequenceGroupCount: 0 },
      { segmentIndex: 2, nativeEventCount: 380, sequenceGroupCount: 2 },
    ],
    withinSegmentDuplicateKeys: [],
    conflictingReplays: [],
    noncontiguousGroups: [],
    ...overrides,
  };
}
