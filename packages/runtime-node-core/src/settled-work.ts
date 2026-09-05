/** Preserve the first operation failure, but never leave sibling work running. */
export async function waitForAll<T>(work: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(work);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<Awaited<T>>).value);
}

/** Attempt every cleanup, including when a hook throws before returning a promise. */
export async function collectCleanupErrors(
  cleanup: Iterable<() => unknown>,
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    [...cleanup].map((operation) => Promise.resolve().then(operation)),
  );
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}
