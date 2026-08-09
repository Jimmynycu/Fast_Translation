import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const WINDOWS_ROOT_ACL_SCRIPT = [
  "& {",
  "param(",
  '  [ValidateSet("harden", "verify")]',
  "  [string] $operation,",
  "  [string] $encodedPaths",
  ")",
  '$ErrorActionPreference = "Stop"',
  '$base64 = $encodedPaths.Replace("-", "+").Replace("_", "/")',
  'switch ($base64.Length % 4) { 2 { $base64 += "==" } 3 { $base64 += "=" } 1 { throw "Invalid encoded path" } }',
  '$decodedRequest = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($base64))',
  '$request = ConvertFrom-Json -InputObject $decodedRequest',
  'if ($null -eq $request -or $null -eq $request.paths) { throw "Windows root ACL request is invalid" }',
  '$paths = [string[]] $request.paths',
  '$boundaryPath = if ($null -eq $request.boundaryPath) { $null } else { [string] $request.boundaryPath }',
  'if ($null -eq $request.strictAncestors) { throw "Windows root ACL strict ancestor mode is required" }',
  '$strictAncestors = [bool] $request.strictAncestors',
  'if ($paths.Count -eq 0) { throw "Windows root ACL paths are required" }',
  '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  'if ($null -eq $identity -or $null -eq $identity.User) { throw "Current Windows identity SID is unavailable" }',
  '$ownerSid = [System.Security.Principal.SecurityIdentifier]::new($identity.User.Value)',
  '$ownerSidText = $ownerSid.Value',
  '$allowedSids = @(',
  '  $ownerSidText',
  '  "S-1-5-18"',
  '  "S-1-5-32-544"',
  ') | Select-Object -Unique',
  '$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
  '$noInheritance = [System.Security.AccessControl.InheritanceFlags]::None',
  '$propagation = [System.Security.AccessControl.PropagationFlags]::None',
  '$accessType = [System.Security.AccessControl.AccessControlType]::Allow',
  '$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '$securitySections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner',
  '# Above a private boundary, ordinary FILE_ADD_FILE/FILE_ADD_SUBDIRECTORY and attribute writes do not replace an existing child.',
  '# Reject only rights that permit child removal/rename or security-owner takeover; reparse points are checked separately.',
  '$boundaryMutationRights = [int64] (',
  '  [System.Security.AccessControl.FileSystemRights]::Delete -bor',
  '  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor',
  '  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor',
  '  [System.Security.AccessControl.FileSystemRights]::TakeOwnership',
  ')',
  '$boundaryGenericWriteRights = [int64] 0x50000000',
  'function New-PrivateDirectorySecurity {',
  '  $acl = [System.Security.AccessControl.DirectorySecurity]::new()',
  '  $acl.SetAccessRuleProtection($true, $false)',
  '  foreach ($sidText in $allowedSids) {',
  '    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)',
  '    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(',
  '      $sid, $fullControl, $inheritance, $propagation, $accessType',
  '    )',
  '    [void] $acl.AddAccessRule($rule)',
  '  }',
  '  return $acl',
  '}',
  'function New-PrivateFileSecurity {',
  '  $acl = [System.Security.AccessControl.FileSecurity]::new()',
  '  $acl.SetAccessRuleProtection($true, $false)',
  '  foreach ($sidText in $allowedSids) {',
  '    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)',
  '    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(',
  '      $sid, $fullControl, $noInheritance, $propagation, $accessType',
  '    )',
  '    [void] $acl.AddAccessRule($rule)',
  '  }',
  '  return $acl',
  '}',
  'function Assert-PrivateDacl($security, $expectedInheritance, [string] $label = "root", [bool] $requireProtection = $true) {',
  '  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])',
  '  if ($null -eq $owner -or $owner.Value -ne $ownerSidText) { throw "Windows root $label owner is not the approved service SID" }',
  '  if ($requireProtection -and -not $security.AreAccessRulesProtected) { throw "Windows root DACL must be protected" }',
  '  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  '  $observed = @{}',
  '  foreach ($rule in $rules) {',
  '    $sid = $rule.IdentityReference.Value',
  '    if ($allowedSids -notcontains $sid) { throw "Windows root DACL contains an unapproved principal" }',
  '    if ($requireProtection -and $rule.IsInherited) { throw "Windows root DACL contains an inherited access rule" }',
  '    if ($rule.AccessControlType -ne $accessType) { throw "Windows root DACL must allow access" }',
  '    if ($rule.FileSystemRights -ne $fullControl) { throw "Windows root DACL must grant full control" }',
  '    if ($rule.InheritanceFlags -ne $expectedInheritance) { throw "Windows root DACL rules have invalid inheritance" }',
  '    if ($rule.PropagationFlags -ne $propagation) { throw "Windows root DACL rules must not restrict inheritance" }',
  '    if ($observed.ContainsKey($sid)) { throw "Windows root DACL contains duplicate rules" }',
  '    $observed[$sid] = $true',
  '  }',
  '  foreach ($sid in $allowedSids) {',
  '    if (-not $observed.ContainsKey($sid)) { throw "Windows root DACL is missing an approved principal" }',
  '  }',
  '}',
  'function Set-PrivateSecurity($entry, $security, $expectedInheritance, [string] $label) {',
  '  $existing = $entry.GetAccessControl($securitySections)',
  '  $existingOwner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])',
  '  if ($null -eq $existingOwner -or $existingOwner.Value -ne $ownerSidText) {',
  '    $security.SetOwner($ownerSid)',
  '  }',
  '  $entry.SetAccessControl($security)',
  '  Assert-PrivateDacl ($entry.GetAccessControl($securitySections)) $expectedInheritance $label',
  '}',
  'function Assert-PrivateAncestorMutationBoundary([System.IO.DirectoryInfo] $ancestor, [bool] $allowVolumeOwner = $false) {',
  '  $security = $ancestor.GetAccessControl($securitySections)',
  '  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])',
  '  if (-not $allowVolumeOwner -and ($null -eq $owner -or $allowedSids -notcontains $owner.Value)) {',
  '    throw "Windows security root ancestor owner is not approved"',
  '  }',
  '  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  '  foreach ($rule in $rules) {',
  '    if ($rule.AccessControlType -ne $accessType) { continue }',
  '    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }',
  '    $sid = $rule.IdentityReference.Value',
  '    if ($allowedSids -contains $sid) { continue }',
  '    $rights = [int64] $rule.FileSystemRights',
  '    if (($rights -band $boundaryMutationRights) -ne 0 -or ($rights -band $boundaryGenericWriteRights) -ne 0) {',
  '      throw "Windows security root ancestor grants an unapproved principal replacement rights"',
  '    }',
  '  }',
  '}',
  'function Assert-PrivateAncestorBoundary([System.IO.DirectoryInfo] $directory, [bool] $hardenParent) {',
  '  $parent = $directory.Parent',
  '  if ($null -eq $parent) { throw "Windows security root requires an approved security parent" }',
  '  $parentName = $parent.FullName.TrimEnd("\\")',
  '  $volumeName = $parent.Root.FullName.TrimEnd("\\")',
  '  if ($parentName -eq $volumeName) { throw "Windows security root requires a non-volume security parent" }',
  '  $boundaryName = $null',
  '  if ($null -ne $boundaryPath) {',
  '    if ([string]::IsNullOrWhiteSpace($boundaryPath)) { throw "Windows security root boundary is invalid" }',
  '    $boundary = [System.IO.DirectoryInfo]::new($boundaryPath)',
  '    if (-not $boundary.Exists) { throw "Windows security root boundary is not a directory" }',
  '    if (($boundary.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Windows security root boundary is a reparse point" }',
  '    $boundaryName = $boundary.FullName.TrimEnd("\\")',
  '  }',
  '  $ancestors = @()',
  '  $boundaryIndex = -1',
  '  for ($cursor = $parent; $null -ne $cursor; $cursor = $cursor.Parent) {',
  '    if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {',
  '      throw "Windows security root has a reparse-point ancestor"',
  '    }',
  '    $ancestors += $cursor',
  '    if ($null -ne $boundaryName -and $cursor.FullName.TrimEnd("\\") -eq $boundaryName) {',
  '      $boundaryIndex = $ancestors.Count - 1',
  '    }',
  '  }',
  '  if ($null -ne $boundaryName -and $boundaryIndex -lt 0) {',
  '    throw "Windows security root is outside the approved security boundary"',
  '  }',
  '  if ($strictAncestors) {',
  '    $mutationStart = if ($boundaryIndex -ge 0) { $boundaryIndex + 1 } else { 1 }',
  '    for ($index = $mutationStart; $index -lt $ancestors.Count; $index += 1) {',
  '      $ancestor = $ancestors[$index]',
  '      $isVolumeRoot = $ancestor.FullName.TrimEnd("\") -eq $ancestor.Root.FullName.TrimEnd("\")',
  '      Assert-PrivateAncestorMutationBoundary $ancestor $isVolumeRoot',
  '    }',
  '  }',
  '  if ($hardenParent) {',
  '    $managedCount = if ($boundaryIndex -ge 0) { $boundaryIndex + 1 } else { 1 }',
  '    for ($index = $managedCount - 1; $index -ge 0; $index -= 1) {',
  '      $label = if ($index -eq 0) { "parent" } else { "security boundary ancestor" }',
  '      Set-PrivateSecurity $ancestors[$index] (New-PrivateDirectorySecurity) $inheritance $label',
  '    }',
  '  } else {',
  '    $managedCount = if ($boundaryIndex -ge 0) { $boundaryIndex + 1 } else { 1 }',
  '    for ($index = 0; $index -lt $managedCount; $index += 1) {',
  '      $label = if ($index -eq 0) { "parent" } else { "security boundary ancestor" }',
  '      Assert-PrivateDacl ($ancestors[$index].GetAccessControl($securitySections)) $inheritance $label',
  '    }',
  '  }',
  '}',
  'function Harden-PrivateDescendants([System.IO.DirectoryInfo] $directory) {',
  '  foreach ($entry in $directory.EnumerateFileSystemInfos()) {',
  '    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {',
  '      throw "Windows root contains a reparse-point descendant"',
  '    }',
  '    if ($entry -is [System.IO.DirectoryInfo]) {',
  '      Set-PrivateSecurity $entry (New-PrivateDirectorySecurity) $inheritance "descendant directory"',
  '      Harden-PrivateDescendants $entry',
  '    } elseif ($entry -is [System.IO.FileInfo]) {',
  '      Set-PrivateSecurity $entry (New-PrivateFileSecurity) $noInheritance "descendant file"',
  '    } else {',
  '      throw "Windows root contains an unsupported descendant"',
  '    }',
  '  }',
  '}',
  'function Assert-PrivateDescendants([System.IO.DirectoryInfo] $directory) {',
  '  foreach ($entry in $directory.EnumerateFileSystemInfos()) {',
  '    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {',
  '      throw "Windows root contains a reparse-point descendant"',
  '    }',
  '    if ($entry -is [System.IO.DirectoryInfo]) {',
  '      Assert-PrivateDacl ($entry.GetAccessControl($securitySections)) $inheritance "descendant directory" $false',
  '      Assert-PrivateDescendants $entry',
  '    } elseif ($entry -is [System.IO.FileInfo]) {',
  '      Assert-PrivateDacl ($entry.GetAccessControl($securitySections)) $noInheritance "descendant file" $false',
  '    } else {',
  '      throw "Windows root contains an unsupported descendant"',
  '    }',
  '  }',
  '}',
  'foreach ($path in $paths) {',
  '  if ([string]::IsNullOrWhiteSpace($path)) { throw "Windows root ACL path is invalid" }',
  '  $directory = [System.IO.DirectoryInfo]::new($path)',
  '  if (-not $directory.Exists) { throw "Windows root ACL path is not a directory" }',
  '  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Windows root ACL path is a reparse point" }',
  '  Assert-PrivateAncestorBoundary $directory ($operation -eq "harden")',
  '  if ($operation -eq "harden") {',
  '    Set-PrivateSecurity $directory (New-PrivateDirectorySecurity) $inheritance "root"',
  '    Harden-PrivateDescendants $directory',
  '  } else {',
  '    Assert-PrivateDacl ($directory.GetAccessControl($securitySections)) $inheritance "root"',
  '    Assert-PrivateDescendants $directory',
  '  }',
  '}',
  "}",
].join("\n");

function encodePowerShellRequest(
  paths: readonly string[],
  boundaryPath: string | undefined,
  strictAncestors: boolean,
): string {
  if (paths.length === 0) throw new RangeError("Windows security root paths are required");
  if (boundaryPath !== undefined && boundaryPath.trim().length === 0) {
    throw new RangeError("Windows security root boundary is required");
  }
  if (typeof strictAncestors !== "boolean") {
    throw new TypeError("Windows security root strict ancestor mode is required");
  }
  if (!strictAncestors && boundaryPath === undefined) {
    throw new RangeError("Windows security root boundary is required when strict ancestor checks are disabled");
  }
  return Buffer.from(JSON.stringify({
    paths,
    boundaryPath: boundaryPath ?? null,
    strictAncestors,
  }), "utf16le").toString("base64url");
}

async function runWindowsRootAclScript(
  operation: "harden" | "verify",
  paths: readonly string[],
  boundaryPath?: string,
  strictAncestors = true,
): Promise<void> {
  await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_ROOT_ACL_SCRIPT,
    operation,
    encodePowerShellRequest(paths, boundaryPath, strictAncestors),
  ], {
    windowsHide: true,
    timeout: 15_000,
  });
}

/**
 * Replaces a root DACL with a protected, inheritable allow-list, sets the
 * approved service owner on the root and descendants, and verifies the result
 * before any managed content is created beneath it. A dedicated boundary may
 * be supplied to scope ancestor ACL hardening; strict ancestor verification is
 * enabled by default and may be disabled only for an explicitly trusted
 * loopback-development boundary.
 */
export async function hardenWindowsSecurityRoot(
  path: string,
  boundaryPath?: string,
  strictAncestors = true,
): Promise<void> {
  try {
    await runWindowsRootAclScript("harden", [path], boundaryPath, strictAncestors);
  } catch (error: unknown) {
    throw new Error("Windows security root ACL hardening failed", { cause: error });
  }
}

/** Verifies that an already hardened root and its descendants retain owner/DACL integrity. */
export async function verifyWindowsSecurityRoot(
  path: string,
  boundaryPath?: string,
  strictAncestors = true,
): Promise<void> {
  try {
    await runWindowsRootAclScript("verify", [path], boundaryPath, strictAncestors);
  } catch (error: unknown) {
    throw new Error("Windows security root ACL verification failed", { cause: error });
  }
}

/** Verifies several roots in one ACL-tool invocation before content I/O. */
export async function verifyWindowsSecurityRoots(
  paths: readonly string[],
  boundaryPath?: string,
  strictAncestors = true,
): Promise<void> {
  try {
    await runWindowsRootAclScript("verify", paths, boundaryPath, strictAncestors);
  } catch (error: unknown) {
    throw new Error("Windows security root ACL verification failed", { cause: error });
  }
}
