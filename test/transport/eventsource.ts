import { EventSource } from "eventsource";
/** Standard published Node EventSource; only fixture authentication/fault injection is supplied. */
export function authenticatedEventSource(
  headers: () => Readonly<Record<string, string>>,
  fetcher: typeof fetch = fetch,
): typeof globalThis.EventSource {
  return class extends EventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, {
        ...init,
        fetch: (url, options) =>
          fetcher(url, { ...options, headers: { ...options.headers, ...headers() } }),
      });
    }
  };
}
