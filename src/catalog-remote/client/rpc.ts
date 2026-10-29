import type { TRPCClient } from "@trpc/client";
import { subscriptionStream } from "../../conversation/index.js";
import type { CatalogRouter } from "../node.js";
import type { CatalogFeed, CatalogListing } from "../contracts.js";
/** Typed tRPC consumer requires Node ambient router types; ./index does not. */
export function createCatalogClient(remote: TRPCClient<CatalogRouter>) {
  const feed: CatalogFeed = {
    watch(selection, signal, unavailable) {
      const source = subscriptionStream<CatalogListing>(
        (observer) =>
          remote.watch.subscribe(
            {
              ...(selection.query ? { query: selection.query } : {}),
              ...(selection.pinned ? { pinned: [...selection.pinned] } : {}),
            },
            observer,
          ),
        unavailable,
      );
      const close = async () => {
        signal.removeEventListener("abort", abort);
        return source.return!();
      };
      const abort = () => {
        void close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const iterator: AsyncIterableIterator<CatalogListing> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        next: () => source.next(),
        return: close,
      };
      return iterator;
    },
  };
  return { remote, feed };
}
