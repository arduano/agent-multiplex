/**
 * Validate the replay-aware native stream summary emitted after the browser
 * reloads its subscription. Replays across reset boundaries are expected;
 * duplicates within one segment, conflicting replay bytes, and gaps are not.
 */
export function nativeStreamSummaryPassed(streams, expectedNativeEvents) {
  if (streams === null || typeof streams !== "object") return false;

  const counts = [
    streams.rawNativeEventCount,
    streams.uniqueNativeEventCount,
    streams.replayCount,
    streams.crossSegmentReplayCount,
    streams.streamResetCount,
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return false;
  }
  if (!Number.isSafeInteger(expectedNativeEvents) || expectedNativeEvents < 1) {
    return false;
  }
  if (
    streams.rawNativeEventCount !== expectedNativeEvents ||
    streams.uniqueNativeEventCount < 1 ||
    streams.uniqueNativeEventCount > streams.rawNativeEventCount ||
    streams.replayCount !==
      streams.rawNativeEventCount - streams.uniqueNativeEventCount ||
    streams.crossSegmentReplayCount !== streams.replayCount ||
    streams.replayCount < 1 ||
    streams.streamResetCount < 1
  ) {
    return false;
  }

  if (
    !Array.isArray(streams.segments) ||
    streams.segments.length !== streams.streamResetCount + 1 ||
    !streams.segments.every((segment, index) =>
      segment !== null &&
      typeof segment === "object" &&
      segment.segmentIndex === index &&
      Number.isSafeInteger(segment.nativeEventCount) &&
      segment.nativeEventCount >= 0 &&
      Number.isSafeInteger(segment.sequenceGroupCount) &&
      segment.sequenceGroupCount >= 0 &&
      segment.sequenceGroupCount <= segment.nativeEventCount &&
      (segment.nativeEventCount === 0) === (segment.sequenceGroupCount === 0)
    ) ||
    streams.segments.reduce(
      (total, segment) => total + segment.nativeEventCount,
      0,
    ) !== streams.rawNativeEventCount
  ) {
    return false;
  }

  return [
    streams.withinSegmentDuplicateKeys,
    streams.conflictingReplays,
    streams.noncontiguousGroups,
  ].every((entries) => Array.isArray(entries) && entries.length === 0);
}
