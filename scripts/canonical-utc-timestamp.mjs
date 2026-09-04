/**
 * Accept the UTC timestamp forms emitted into native qualification receipts.
 *
 * JavaScript's `toISOString()` always uses millisecond precision, while
 * Docker's Go `time.RFC3339Nano` representation removes trailing fractional
 * zeroes and therefore uses anywhere from one through nine digits. Compare at
 * JavaScript's millisecond precision after first bounding the wire syntax.
 */
export function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string") return false;

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (match === null) return false;

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;

  const fractionalMilliseconds = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  return new Date(milliseconds).toISOString() ===
    `${match[1]}.${fractionalMilliseconds}Z`;
}
