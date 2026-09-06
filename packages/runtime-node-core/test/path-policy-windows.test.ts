import { describe, expect, it, vi } from "vitest";

vi.mock("node:path", async (original) => {
  const paths = await original<typeof import("node:path")>();
  return { ...paths, ...paths.win32 };
});
vi.mock("node:fs/promises", () => ({ realpath: async (path: string) => path }));

import { AllowedPathPolicy } from "../src/path-policy.js";

describe("Windows allowed roots", () => {
  it("admits descendants and case differences on the same drive", async () => {
    const policy = new AllowedPathPolicy([String.raw`C:\work`]);
    await expect(policy.validate(String.raw`c:\WORK\project`)).resolves.toBe(String.raw`c:\WORK\project`);
    await expect(policy.validate(String.raw`C:\work`)).resolves.toBe(String.raw`C:\work`);
  });

  it.each([
    String.raw`D:\work\project`, String.raw`\\server\share\project`,
    String.raw`C:\work-other`, String.raw`C:\other`, String.raw`C:relative`,
  ])("rejects paths outside the drive/root fence: %s", async (path) => {
    await expect(new AllowedPathPolicy([String.raw`C:\work`]).validate(path)).rejects.toThrow();
  });

  it("does not mix UNC servers or shares", async () => {
    const policy = new AllowedPathPolicy([String.raw`\\server\share\work`]);
    await expect(policy.validate(String.raw`\\server\share\work\project`)).resolves.toBeTruthy();
    await expect(policy.validate(String.raw`\\other\share\work`)).rejects.toThrow();
    await expect(policy.validate(String.raw`\\server\other\work`)).rejects.toThrow();
  });
});
