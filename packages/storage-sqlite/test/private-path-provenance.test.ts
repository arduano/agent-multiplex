import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("node:path", async original => {
  const module = await original<typeof import("node:path")>();
  return { ...module, ...module.win32 };
});
import { assertPrivateFilesSync, ensurePrivateDirectorySync, PrivatePathError, privatePathFailure } from "../src/private-path.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const accepted = { status: 0, signal: null, stdout: "private-path-ok", stderr: "" };
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mocks.spawn.mockReset(); mocks.spawn.mockReturnValue({ ...accepted });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function caught(operation: "directory" | "files" = "directory") {
  try {
    if (operation === "directory") ensurePrivateDirectorySync("C:\\Disposable\\private");
    else assertPrivateFilesSync(["C:\\Disposable\\private\\value.json"]);
  } catch (error) { return error; }
  throw new Error("fixture must refuse private admission");
}

describe("native private-path failure provenance", () => {
  it.each([0, null])("retains original ETIMEDOUT despite late native status %s", status => {
    const cause = Object.assign(new Error("PRIVATE native detail"), { code: "ETIMEDOUT" });
    mocks.spawn.mockReturnValue({ ...accepted, error: cause, status });
    const error = caught();
    expect(error).toBeInstanceOf(PrivatePathError);
    expect((error as Error).cause).toBe(cause);
    expect(privatePathFailure(error)).toMatchObject({ operation: "directory", kind: "timeout", code: "ETIMEDOUT", status, signal: null, timeoutMs: 30_000 });
    expect(privatePathFailure(error)?.stage).toBeUndefined();
    expect(JSON.stringify(privatePathFailure(error))).not.toContain("PRIVATE");
    expect(Object.isFrozen(privatePathFailure(error))).toBe(true);
    const args = mocks.spawn.mock.calls[0]!;
    expect(args[1].slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"]);
    expect(args[2]).toMatchObject({ timeout: 30_000, windowsHide: true, maxBuffer: 16_384 });
  });

  it("does not grant a native refusal marker authority over the spawn error", () => {
    mocks.spawn.mockReturnValue({ error: Object.assign(new Error("private"), { code: "ETIMEDOUT" }), status: 1, signal: "SIGTERM",
      stdout: "private-path-failure:owner:RuntimeException", stderr: "" });
    expect(privatePathFailure(caught())).toMatchObject({ kind: "timeout", code: "ETIMEDOUT", status: 1, signal: "SIGTERM" });
    expect(privatePathFailure(caught())?.stage).toBeUndefined();
  });

  it("classifies exact nonzero private refusal with safe stage and exception", () => {
    mocks.spawn.mockReturnValue({ status: 1, signal: null, stdout: "private-path-failure:untrusted:RuntimeException", stderr: "PRIVATE" });
    const error = caught("files");
    expect(privatePathFailure(error)).toMatchObject({ operation: "files", kind: "refused", stage: "untrusted", exceptionClass: "RuntimeException", status: 1 });
    expect((error as Error).message).toContain("(untrusted: RuntimeException)");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(privatePathFailure(error))).not.toContain("PRIVATE");
  });

  it.each([
    { status: 0, signal: null, stdout: "private-path-failure:owner:RuntimeException" },
    { status: null, signal: null, stdout: "private-path-failure:owner:RuntimeException" },
    { status: 1, signal: "SIGTERM", stdout: "private-path-failure:owner:RuntimeException" },
    { status: 1, signal: null, stdout: "private-path-failure:owner:RuntimeException\n" },
    { status: 1, signal: null, stdout: "private-path-failure:unknown:RuntimeException" },
    { status: 1, signal: null, stdout: "private-path-failure:owner:RuntimeException:PRIVATE" },
    { status: 1, signal: null, stdout: "PRIVATE private-path-failure:owner:RuntimeException" },
    { status: 1, signal: null, stdout: "private-path-ok" },
    { status: 0, signal: "SIGTERM", stdout: "private-path-ok" },
  ])("keeps contradictory, malformed and terminated markers unknown: %j", result => {
    mocks.spawn.mockReturnValue({ ...result, stderr: "PRIVATE" });
    const failure = privatePathFailure(caught());
    expect(failure?.kind).toBe("unknown"); expect(failure?.stage).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
  });

  it("omits unknown exception names and process metadata without exposing raw data", () => {
    mocks.spawn.mockReturnValue({ status: 1, signal: null, stdout: "private-path-failure:inspect:PrivateCredentialException", stderr: "PRIVATE" });
    expect(privatePathFailure(caught())).toMatchObject({ kind: "refused", stage: "inspect", exceptionClass: "otherException" });
    mocks.spawn.mockReturnValue({ error: Object.assign(new Error("PRIVATE"), { code: "PRIVATE_CODE" }), status: Number.NaN, signal: "PRIVATE_SIGNAL", stdout: "" });
    expect(privatePathFailure(caught())).toEqual(expect.objectContaining({ kind: "spawn" }));
    expect(privatePathFailure(caught())).not.toHaveProperty("code");
    expect(privatePathFailure(caught())).not.toHaveProperty("status");
    expect(privatePathFailure(caught())).not.toHaveProperty("signal");
  });

  it("does not run an error code getter or infer provenance from error text", () => {
    const read = vi.fn(() => "ETIMEDOUT");
    const error = new Error("timed out PRIVATE"); Object.defineProperty(error, "code", { get: read });
    mocks.spawn.mockReturnValue({ error, status: null, signal: null, stdout: "" });
    expect(privatePathFailure(caught())?.kind).toBe("spawn"); expect(read).not.toHaveBeenCalled();
    expect(privatePathFailure(new Error("Windows private state timeout"))).toBeUndefined();
    expect(privatePathFailure(Object.assign(new PrivatePathError("synthetic"), { kind: "timeout", code: "ETIMEDOUT" }))).toBeUndefined();
  });

  it("retains native batching and does not run paths as executable PowerShell text", () => {
    const filenames = Array.from({ length: 17 }, (_, index) => `C:\\Disposable\\private\\${index}.json`);
    assertPrivateFilesSync(filenames);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls.map(call => JSON.parse(call[2].env.AGENT_MULTIPLEX_PRIVATE_PATH_REQUEST).paths.length)).toEqual([16, 1]);
    expect(mocks.spawn.mock.calls[0]![1].join(" ")).not.toContain(filenames[0]);
  });
});
