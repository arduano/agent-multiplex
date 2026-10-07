import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type PrivatePathNativeStage = "request" | "create" | "inspect" | "acl" | "rules" | "owner" | "inherited" | "untrusted" | "useraccess";
export type PrivatePathNativeException = "UnauthorizedAccessException" | "DirectoryNotFoundException" | "FileNotFoundException" | "IOException"
  | "ArgumentException" | "InvalidOperationException" | "SecurityException" | "NotSupportedException" | "RuntimeException" | "MethodInvocationException" | "otherException";

/** Safe operation provenance; it never contains a path, subprocess output or
 * exception message. Timeout is certified by spawn, never by elapsed time. */
export interface PrivatePathFailure {
  readonly operation: "directory" | "files";
  readonly kind: "timeout" | "spawn" | "refused" | "unknown";
  readonly elapsedMs: number;
  readonly code?: string;
  readonly stage?: PrivatePathNativeStage;
  readonly exceptionClass?: PrivatePathNativeException;
  readonly status?: number | null;
  readonly signal?: string | null;
  readonly timeoutMs?: number;
}
const privatePathFailures = new WeakMap<PrivatePathError, Readonly<PrivatePathFailure>>();
const nativeCodes = new Set(["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "EPIPE", "EIO", "ENOSPC", "EMFILE", "ENFILE", "ENOBUFS", "EAGAIN", "EINVAL"]);
const nativeSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"]);
const nativeExceptions = new Set<PrivatePathNativeException>(["UnauthorizedAccessException", "DirectoryNotFoundException", "FileNotFoundException", "IOException",
  "ArgumentException", "InvalidOperationException", "SecurityException", "NotSupportedException", "RuntimeException", "MethodInvocationException"]);

export class PrivatePathError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "PrivatePathError"; }
}

/** Only framework-produced errors carry provenance. Error text, lookalike
 * fields and unrelated causes cannot manufacture a private-path certificate. */
export function privatePathFailure(error: unknown): Readonly<PrivatePathFailure> | undefined {
  return error instanceof PrivatePathError ? privatePathFailures.get(error) : undefined;
}

function ownCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const property = Object.getOwnPropertyDescriptor(error, "code");
  return property && "value" in property && typeof property.value === "string" ? property.value : undefined;
}

/** Create a private directory, or validate an existing one without widening access. */
export function ensurePrivateDirectorySync(directory: string): void {
  if (process.platform === "win32") {
    windowsPrivatePaths("directory", [resolve(directory)]);
    return;
  }
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new PrivatePathError("private state path must be a non-symlink directory");
  }
  if (existed && (status.mode & 0o777) !== 0o700) {
    throw new PrivatePathError("private state directory must have mode 0700");
  }
  if (!existed) chmodSync(directory, 0o700);
}

/** Validate a regular file's Windows DACL; POSIX callers retain mode 0600. */
export function assertPrivateFileSync(filename: string): void {
  assertPrivateFilesSync([filename]);
}

export function assertPrivateFilesSync(filenames: readonly string[]): void {
  if (filenames.length === 0) return;
  if (process.platform === "win32") {
    // Keep the subprocess environment bounded even for a retained image store.
    for (let index = 0; index < filenames.length; index += 16) {
      windowsPrivatePaths("files", filenames.slice(index, index + 16).map((filename) => resolve(filename)));
    }
    return;
  }
  for (const filename of filenames) {
    const status = lstatSync(filename);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new PrivatePathError("private state path must be a regular non-symlink file");
    }
    chmodSync(filename, 0o600);
  }
}

// Constant program only: paths arrive as JSON in the environment, never as
// executable PowerShell text. No profiles, execution-policy override, or raw
// PowerShell diagnostics are exposed. New directories receive their protected
// DACL at creation; existing paths are only inspected, never silently repaired.
const WINDOWS_PRIVATE_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'request'
try {
  $request = ConvertFrom-Json $env:AGENT_MULTIPLEX_PRIVATE_PATH_REQUEST
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($path in $request.paths) {
    if ($request.operation -eq 'directory' -and -not [System.IO.Directory]::Exists($path)) {
      $stage = 'create'
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetOwner($user)
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($sid in $trusted) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      [void][System.IO.Directory]::CreateDirectory($path, $acl)
    }
    $stage = 'inspect'
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
    $directory = $request.operation -eq 'directory'
    if ($item.PSIsContainer -ne $directory) { throw 'wrong path type' }
    $stage = 'acl'
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
    if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { $stage = 'owner'; throw 'untrusted owner' }
    if ($directory -and -not $acl.AreAccessRulesProtected) { $stage = 'inherited'; throw 'directory inherits access' }
    $stage = 'rules'
    $userAccess = $false
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    if ($rules.Count -eq 0) { $stage = 'untrusted'; throw 'missing DACL rules' }
    foreach ($rule in $rules) {
      if ($trusted -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow') { $stage = 'untrusted'; throw 'untrusted access rule' }
      if ($rule.IdentityReference.Value -eq $user.Value -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
        if (-not $directory -or
            ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
            ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) { $userAccess = $true }
      }
    }
    # File validation fences who can access its bytes. Its actual read/write
    # operation checks usability; requiring a particular effective rights mask
    # would reject private files created with mapped GENERIC_READ/WRITE ACEs.
    if ($directory -and -not $userAccess) { $stage = 'useraccess'; throw 'missing owner access' }
  }
  [Console]::Out.Write('private-path-ok')
} catch { [Console]::Out.Write('private-path-failure:' + $stage + ':' + $_.Exception.GetType().Name); exit 1 }
`;

function windowsPrivatePaths(operation: "directory" | "files", paths: readonly string[]): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new PrivatePathError("Windows private state validation requires a valid SystemRoot");
  }
  const began = performance.now();
  const result = spawnSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_PATH_SCRIPT], {
      env: { ...process.env, AGENT_MULTIPLEX_PRIVATE_PATH_REQUEST: JSON.stringify({ operation, paths }) },
      encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16_384,
    });
  if (result.error || result.status !== 0 || result.signal !== null || result.stdout !== "private-path-ok") {
    const code = ownCode(result.error);
    // An error can coexist with status 0 and even a success marker after the
    // deadline. Its original spawn outcome wins; late exit is not admission.
    const marker = !result.error && result.signal === null && Number.isSafeInteger(result.status) && result.status !== 0
      ? /^private-path-failure:(request|create|inspect|acl|rules|owner|inherited|untrusted|useraccess):([A-Za-z]+Exception)$/.exec(result.stdout ?? "") : null;
    const stage = marker?.[1] as PrivatePathNativeStage | undefined;
    const exceptionClass = marker ? nativeExceptions.has(marker[2] as PrivatePathNativeException)
      ? marker[2] as PrivatePathNativeException : "otherException" : undefined;
    const error = new PrivatePathError("Windows private state requires a regular path with access restricted to the current user, SYSTEM and Administrators; existing directory ACLs must be protected and inherit to children" + (marker ? ` (${marker[1]}: ${marker[2]})` : ""),
      result.error ? { cause: result.error } : undefined);
    privatePathFailures.set(error, Object.freeze({ operation,
      kind: code === "ETIMEDOUT" ? "timeout" : result.error ? "spawn" : marker ? "refused" : "unknown",
      elapsedMs: Math.max(0, Math.floor(performance.now() - began)), timeoutMs: 30_000,
      ...(typeof code === "string" && nativeCodes.has(code) ? { code } : {}),
      ...(result.status === null || Number.isSafeInteger(result.status) && result.status >= -0x80000000 && result.status <= 0xffffffff ? { status: result.status } : {}),
      ...(result.signal === null || nativeSignals.has(result.signal) ? { signal: result.signal } : {}),
      ...(stage ? { stage, exceptionClass: exceptionClass! } : {}) }));
    throw error;
  }
}
