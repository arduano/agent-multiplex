import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { MutableStatePaths } from "../node-contracts.js";
/** Payload is immutable/package-owned. Mutable agent data and machine trust
 * are explicit disjoint private directories, never npm/Nix output paths. */
export async function statePaths(input: MutableStatePaths) {
  const values = [input.agents, input.system];
  if (
    values[0] === values[1] ||
    values[0]!.startsWith(values[1] + "/") ||
    values[1]!.startsWith(values[0] + "/")
  )
    throw Error("Agent and machine state must be disjoint");
  for (const value of values) {
    if (
      !isAbsolute(value) ||
      normalize(value) !== value ||
      value === "/nix/store" ||
      value.startsWith("/nix/store/")
    )
      throw Error("Invalid mutable state path");
    await mkdir(value, { recursive: true, mode: 0o700 });
    const info = await lstat(value);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw Error("Mutable state must be owned by this account");
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(value)) !== value
    )
      throw Error("Mutable state must be canonical and private");
  }
  return Object.freeze({ ...input });
}
