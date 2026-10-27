import { SessionError, type CodexAccess } from '../../v8-session/src/contracts/types.js';

/** rust-v0.162.1 permissions.rs SandboxPolicy and the core policy constructors.
 * Writable roots are additional to the native cwd; no client-selected paths or
 * network override are introduced by the coarse sandbox selector. */
export function encodeCodexSandbox(access: CodexAccess) {
  if (access.profile !== undefined) throw new SessionError('INVALID');
  switch (access.sandbox) {
    case 'danger-full-access': return { type: 'dangerFullAccess' as const };
    case 'read-only': return { type: 'readOnly' as const, networkAccess: false };
    case 'workspace-write': return { type: 'workspaceWrite' as const, writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}
export type CodexOpeningAccess = Readonly<{ approvalPolicy: CodexAccess['approval'] }> & (
  Readonly<{ sandbox: NonNullable<CodexAccess['sandbox']>; permissions?: never }> |
  Readonly<{ permissions: string; sandbox?: never }>
);
export const codexOpeningAccess = (access: CodexAccess): CodexOpeningAccess => access.profile === undefined
  ? { approvalPolicy: access.approval, sandbox: access.sandbox }
  : { approvalPolicy: access.approval, permissions: access.profile };
