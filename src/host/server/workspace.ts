import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { WorkspaceAllocation, WorkspaceRefusal, WorkspaceStrategy } from "../contracts.js";

/** References an existing Host-local directory; it provisions no machine or
 * directory and cannot delete a user's workspace. */
export function existingDirectoryWorkspace() {
  const input = z.object({ cwd: z.string().min(1) }).strict(),
    data = z.null();
  return {
    identity: { id: "multiplex.existing-directory", version: 1, recordVersion: 1 },
    input,
    data,
    async allocate({
      input,
    }: {
      input: { cwd: string };
    }): Promise<WorkspaceAllocation<null> | WorkspaceRefusal> {
      if (!isAbsolute(input.cwd)) return { state: "refused", noAllocation: true };
      const cwd = await realpath(input.cwd);
      if (!(await stat(cwd)).isDirectory()) return { state: "refused", noAllocation: true };
      return { cwd, ownership: "borrowed", data: null };
    },
  } satisfies WorkspaceStrategy<typeof input, typeof data>;
}
