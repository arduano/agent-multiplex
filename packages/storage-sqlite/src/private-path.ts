import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export class PrivatePathError extends Error {
  constructor(message: string) { super(message); this.name = "PrivatePathError"; }
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
    $acl = Get-Acl -LiteralPath $path
    if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'untrusted owner' }
    if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'directory inherits access' }
    $stage = 'rules'
    $userAccess = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($trusted -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow') { throw 'untrusted access rule' }
      if ($rule.IdentityReference.Value -eq $user.Value -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
        if (-not $directory -or
            ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
            ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) { $userAccess = $true }
      }
    }
    if (-not $userAccess) { throw 'missing owner access' }
  }
  [Console]::Out.Write('private-path-ok')
} catch { [Console]::Out.Write('private-path-failure:' + $stage + ':' + $_.Exception.GetType().Name); exit 1 }
`;

function windowsPrivatePaths(operation: "directory" | "files", paths: readonly string[]): void {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new PrivatePathError("Windows private state validation requires a valid SystemRoot");
  }
  const result = spawnSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_PATH_SCRIPT], {
      env: { ...process.env, AGENT_MULTIPLEX_PRIVATE_PATH_REQUEST: JSON.stringify({ operation, paths }) },
      encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16_384,
    });
  if (result.error || result.status !== 0 || result.stdout !== "private-path-ok") {
    const stage = /^private-path-failure:(request|create|inspect|acl|rules):([A-Za-z]+Exception)$/.exec(result.stdout ?? "");
    throw new PrivatePathError("Windows private state requires a regular path with access restricted to the current user, SYSTEM and Administrators; existing directory ACLs must be protected and inherit to children" + (stage ? ` (${stage[1]}: ${stage[2]})` : ""));
  }
}
