import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { PluginIdentity } from "../../v8-plugins/src/contracts.js";
import { SessionError, type SessionScope } from "../../v8-session/src/contracts/types.js";

export type WorkspaceRequest<Input> = Readonly<{ id: string; scope: SessionScope; input: Input }>;
export type WorkspaceAllocation<Data> = Readonly<{ id: string; cwd: string; ownership: "borrowed" | "owned"; data: Data }>;
/** Positive original-specific proof that allocation performed no resource
 * mutation. A thrown error, missing path or current absence is not this proof
 * for an effectful strategy. */
export type WorkspaceRefusal = Readonly<{ state: "refused"; noAllocation: true }>;
export type WorkspaceAllocationResult<Data> = WorkspaceAllocation<Data> | WorkspaceRefusal;
export type WorkspaceOriginal<Data> = Readonly<{ state: "available"; allocation: WorkspaceAllocation<Data> }> | Readonly<{ state: "unknown" }> | WorkspaceRefusal;
/** The strategy owns allocation effects keyed by the immutable original. A lost
 * reply is resolved only through original(); allocate() is never a recovery API. */
export interface WorkspaceStrategy<Input extends z.ZodType, Data extends z.ZodType> {
  readonly identity: PluginIdentity;
  readonly createInput: Input;
  readonly publicData: Data;
  allocate(request: WorkspaceRequest<z.output<Input>>): Promise<WorkspaceAllocationResult<z.output<Data>>>;
  original(request: WorkspaceRequest<z.output<Input>>): Promise<WorkspaceOriginal<z.output<Data>>>;
  inspect(allocation: WorkspaceAllocation<z.output<Data>>): Promise<"available" | "released" | "unknown">;
  /** Absent for borrowed resources; Stop never calls this. */
  release?(allocation: WorkspaceAllocation<z.output<Data>>): Promise<"released" | "unknown">;
}

export type ExistingDirectoryWorkspaceOptions = Readonly<{ allowedRoots?: readonly string[] }>;
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** A canonical borrowed directory, never ownership of its contents or a
 * creation effect. Trusted roots are rechecked on allocation/recovery; they
 * are policy rather than part of the persisted strategy/schema identity.
 */
export function existingDirectoryWorkspace(options: ExistingDirectoryWorkspaceOptions = {}) {
  const createInput = z.object({ cwd: z.string().min(1).max(4096) }).strict();
  const publicData = z.object({ kind: z.literal("existing-directory") }).strict();
  const roots = options.allowedRoots === undefined ? undefined : Object.freeze([...options.allowedRoots]);
  if (roots?.some(root => !isAbsolute(root))) throw new SessionError("INVALID", "Workspace roots must be absolute");
  async function directory(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new SessionError("INVALID", "Working directory must be absolute");
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new SessionError("INVALID", "Working directory must exist");
    if (roots !== undefined) {
      const admitted = await Promise.all(roots.map(async root => {
        const canonicalRoot = await realpath(root);
        if (!(await stat(canonicalRoot)).isDirectory()) throw new SessionError("INVALID", "Workspace root unavailable");
        return within(canonicalRoot, canonical);
      }));
      if (!admitted.some(Boolean)) throw new SessionError("INVALID", "Working directory is outside allowed roots");
    }
    return canonical;
  }
  type Data = z.output<typeof publicData>;
  const allocation = async (request: WorkspaceRequest<z.output<typeof createInput>>): Promise<WorkspaceAllocation<Data>> => {
    const input = createInput.parse(request.input);
    return { id: request.id, cwd: await directory(input.cwd), ownership: "borrowed", data: { kind: "existing-directory" } };
  };
  return {
    identity: { id: "multiplex.existing-directory", version: 1, recordVersion: 1 }, createInput, publicData,
    allocate: async (request: WorkspaceRequest<z.output<typeof createInput>>): Promise<WorkspaceAllocationResult<Data>> => {
      // This strategy performs only validation/metadata reads. Its refusal is
      // no-effect evidence at this observation, not a claim about path absence.
      try { return await allocation(request); } catch { return { state: "refused", noAllocation: true }; }
    },
    original: async (request: WorkspaceRequest<z.output<typeof createInput>>): Promise<WorkspaceOriginal<Data>> => {
      try { return { state: "available", allocation: await allocation(request) }; } catch { return { state: "refused", noAllocation: true }; }
    },
    inspect: async (value: WorkspaceAllocation<Data>): Promise<"available" | "unknown"> => {
      if (value.ownership !== "borrowed" || !isAbsolute(value.cwd) || !publicData.safeParse(value.data).success) throw new SessionError("FENCED");
      try { return await directory(value.cwd) === value.cwd ? "available" : "unknown"; } catch { return "unknown"; }
    },
  } satisfies WorkspaceStrategy<typeof createInput, typeof publicData>;
}
