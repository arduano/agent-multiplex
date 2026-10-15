/** A caller deadline never cancels or relinquishes its underlying owner. */
export async function observeWithin<T>(owner: Promise<T>, timeoutMs: number, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), timeoutMs); });
  try { return await Promise.race([owner, deadline]); } finally { clearTimeout(timer); }
}
export function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new RangeError(`${name} must be between 1 and 600000`);
  return value;
}
