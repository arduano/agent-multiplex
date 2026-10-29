import { RetainedChildStreams, type ChildStreamFeed } from "../../src/child-streams/index.js";
export type BrowserChildFeed = ChildStreamFeed;
export const BrowserChildOwner = RetainedChildStreams;
// @ts-expect-error Browser child views do not expose native Host factories.
import { ChildStreamOwner } from "../../src/child-streams/index.js";
void ChildStreamOwner;
