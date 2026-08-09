import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  hardenWindowsSecurityRoot,
  verifyWindowsSecurityRoot,
} from "../src/adapters/security/windows-root-acl.js";

const execFile = promisify(execFileCallback);
const taskTemp = join(process.cwd(), "work", "tmp", "windows-root-acl-tests");

async function freshBoundary(name: string): Promise<{ boundary: string; root: string }> {
  const boundary = join(taskTemp, name);
  await rm(boundary, { recursive: true, force: true });
  const root = join(boundary, "root");
  await mkdir(root, { recursive: true });
  return { boundary, root };
}

async function setOwner(path: string, sid: string): Promise<boolean> {
  await execFile("icacls.exe", [path, "/setowner", "*" + sid, "/c"], { windowsHide: true });
  const probe = await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param([string] $path); (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value }",
    path,
  ], { windowsHide: true });
  return probe.stdout.trim() === sid;
}

async function setAncestorPublicRights(path: string, rights: number): Promise<void> {
  await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "& {",
      "param([string] $path, [int64] $publicRights)",
      "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
      "if ($null -eq $identity -or $null -eq $identity.User) { throw 'Current Windows identity SID is unavailable' }",
      "$allowedSids = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique",
      "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
      "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
      "$acl.SetAccessRuleProtection($true, $false)",
      "foreach ($sidText in $allowedSids) {",
      "  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(",
      "    [System.Security.Principal.SecurityIdentifier]::new($sidText),",
      "    [System.Security.AccessControl.FileSystemRights]::FullControl,",
      "    $inheritance,",
      "    [System.Security.AccessControl.PropagationFlags]::None,",
      "    [System.Security.AccessControl.AccessControlType]::Allow",
      "  )",
      "  [void] $acl.AddAccessRule($rule)",
      "}",
      "$publicRule = [System.Security.AccessControl.FileSystemAccessRule]::new(",
      "  [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),",
      "  [System.Security.AccessControl.FileSystemRights] $publicRights,",
      "  $inheritance,",
      "  [System.Security.AccessControl.PropagationFlags]::None,",
      "  [System.Security.AccessControl.AccessControlType]::Allow",
      ")",
      "[void] $acl.AddAccessRule($publicRule)",
      "([System.IO.DirectoryInfo]::new($path)).SetAccessControl($acl)",
      "}",
    ].join("\n"),
    path,
    String(rights),
  ], { windowsHide: true });
}

async function hasUnapprovedReplacementRightsAbove(boundary: string): Promise<boolean> {
  const probe = await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "& {",
      "param([string] $boundary)",
      "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
      "$allowedSids = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique",
      "$dangerous = [int64] (",
      "  [System.Security.AccessControl.FileSystemRights]::Delete -bor",
      "  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor",
      "  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor",
      "  [System.Security.AccessControl.FileSystemRights]::TakeOwnership",
      ")",
      "$genericWrite = [int64] 0x50000000",
      "$cursor = [System.IO.DirectoryInfo]::new($boundary).Parent",
      "while ($null -ne $cursor) {",
      "  $rules = @($cursor.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
      "  foreach ($rule in $rules) {",
      "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }",
      "    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }",
      "    if ($allowedSids -contains $rule.IdentityReference.Value) { continue }",
      "    $rights = [int64] $rule.FileSystemRights",
      "    if (($rights -band $dangerous) -ne 0 -or ($rights -band $genericWrite) -ne 0) { return $true }",
      "  }",
      "  $cursor = $cursor.Parent",
      "}",
      "return $false",
      "}",
    ].join("\n"),
    boundary,
  ], { windowsHide: true });
  return probe.stdout.trim() === "True";
}

test("Windows ACL hardening assigns and verifies the approved owner on descendants", {
  skip: process.platform !== "win32",
}, async () => {
  const { boundary, root } = await freshBoundary("owner-descendants");
  const nested = join(root, "nested");
  const file = join(nested, "artifact.bin");
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(file, "private\n");
    await hardenWindowsSecurityRoot(root, boundary, false);
    const inheritedNested = join(root, "created-after-hardening");
    const inheritedFile = join(inheritedNested, "inherited.bin");
    await mkdir(inheritedNested, { recursive: true });
    await writeFile(inheritedFile, "inherited\n");
    await verifyWindowsSecurityRoot(root, boundary, false);

    const expected = (await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ], { windowsHide: true })).stdout.trim();
    const owners: string[] = [];
    for (const path of [root, nested, file, inheritedNested, inheritedFile]) {
      owners.push((await execFile("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { param([string] $path); (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value }",
        path,
      ], { windowsHide: true })).stdout.trim());
    }
    assert.deepEqual(owners, [expected, expected, expected, expected, expected]);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test("Windows ACL verification rejects a pre-existing wrong owner", {
  skip: process.platform !== "win32",
}, async (testContext) => {
  const { boundary, root } = await freshBoundary("wrong-owner");
  try {
    const changed = await setOwner(root, "S-1-5-18");
    if (!changed) {
      testContext.skip("the Windows test token cannot assign a wrong owner");
      return;
    }
    await hardenWindowsSecurityRoot(root, boundary, false);
    await verifyWindowsSecurityRoot(root, boundary, false);
    if (await setOwner(root, "S-1-5-18")) {
      await assert.rejects(
        verifyWindowsSecurityRoot(root, boundary, false),
        /ACL verification failed/u,
      );
    }
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test("Windows ACL verification rejects a writable security parent", {
  skip: process.platform !== "win32",
}, async () => {
  const { boundary, root } = await freshBoundary("writable-parent");
  try {
    await hardenWindowsSecurityRoot(root, boundary, false);
    await execFile("icacls.exe", [boundary, "/grant", "*S-1-1-0:(OI)(CI)F"], {
      windowsHide: true,
    });
    await assert.rejects(
      verifyWindowsSecurityRoot(root, boundary, false),
      /ACL/u,
    );
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test("Windows ACL strict ancestor mode rejects a replaceable parent above the boundary", {
  skip: process.platform !== "win32",
}, async () => {
  const isolation = join(taskTemp, "strict-ancestor");
  const boundary = join(isolation, "data");
  const root = join(boundary, "root");
  await rm(isolation, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    await setAncestorPublicRights(isolation, 64 + 262144);
    await assert.rejects(
      hardenWindowsSecurityRoot(root, boundary),
      /ACL hardening failed/u,
    );
  } finally {
    await rm(isolation, { recursive: true, force: true });
  }
});

test("Windows ACL strict ancestors allow volume-style append rights when the host boundary permits it", {
  skip: process.platform !== "win32",
}, async (testContext) => {
  const appendIsolation = join(taskTemp, "append-only-ancestor");
  const appendBoundary = join(appendIsolation, "data");
  const appendRoot = join(appendBoundary, "root");
  await rm(appendIsolation, { recursive: true, force: true });
  await mkdir(appendRoot, { recursive: true });
  try {
    // FILE_APPEND_DATA on a directory is FILE_ADD_SUBDIRECTORY: it can create
    // unrelated siblings but cannot remove/rename the existing boundary.
    await setAncestorPublicRights(appendIsolation, 4);
    if (await hasUnapprovedReplacementRightsAbove(appendBoundary)) {
      testContext.skip("workspace ancestors carry replacement rights; append-only volume case is unavailable");
      return;
    }
    await hardenWindowsSecurityRoot(appendRoot, appendBoundary);
    await verifyWindowsSecurityRoot(appendRoot, appendBoundary);
  } finally {
    await rm(appendIsolation, { recursive: true, force: true });
  }
});

test("Windows ACL hardening rejects a reparse-point ancestor", {
  skip: process.platform !== "win32",
}, async () => {
  const { boundary } = await freshBoundary("reparse-ancestor");
  const physical = join(boundary, "physical");
  const linked = join(boundary, "linked");
  try {
    await mkdir(join(physical, "root"), { recursive: true });
    await symlink(physical, linked, "junction");
    await assert.rejects(
      hardenWindowsSecurityRoot(join(linked, "root"), boundary, false),
      (error: unknown) => /reparse.*ancestor/u.test(String((error as Error & { cause?: unknown }).cause ?? error)),
    );
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});
