import { describe, expect, it } from "vitest";

import {
  assertReviewedIrohLock,
  assertReviewedIrohManifest,
  reviewedIrohClosure,
  rootManifest,
} from "../scripts/release-config.mjs";

function reviewedLock() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: Object.fromEntries(reviewedIrohClosure.map(({ name, url }) => [name, url])),
      },
      ...Object.fromEntries(reviewedIrohClosure.map(({ name, url, integrity }) => [
        `node_modules/${name}`,
        { version: "0.6.2", resolved: url, integrity },
      ])),
    } as Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>,
  };
}

describe("reviewed Iroh release closure", () => {
  it("requires exact root URL pins and transitive overrides", () => {
    expect(() => assertReviewedIrohManifest(rootManifest)).not.toThrow();
    expect(() => assertReviewedIrohManifest({ ...rootManifest, overrides: {} })).toThrow(/override/);
  });

  it("rejects public and nested Iroh substitutions in isolated consumers", () => {
    const lock = reviewedLock();
    expect(() => assertReviewedIrohLock(lock)).not.toThrow();
    const node = reviewedIrohClosure[0]!;
    const nodePath = `node_modules/${node.name}`;
    lock.packages[nodePath]!.resolved = "https://registry.npmjs.org/@momics/iroh-http-node/-/iroh-http-node-0.6.2.tgz";
    expect(() => assertReviewedIrohLock(lock)).toThrow(/reviewed/);
    lock.packages[nodePath]!.resolved = node.url;
    lock.packages[`node_modules/other/${nodePath}`] = {
      ...lock.packages[nodePath], integrity: "sha512-public-package",
    };
    expect(() => assertReviewedIrohLock(lock)).toThrow(/nested/);
  });
});
