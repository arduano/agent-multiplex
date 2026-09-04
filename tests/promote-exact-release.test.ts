import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareSemver,
  promoteExactRelease,
} from "../scripts/promote-exact-release.mjs";

const commit = "1234567890abcdef1234567890abcdef12345678";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("exact release dist-tag recovery", () => {
  it("preflights every exact package before promoting and verifies both tags", async () => {
    const fixture = createFixture();
    const tags = new Map(fixture.packages.map(({ name }) => [name, {
      next: "0.1.0",
      latest: "0.0.9",
    }]));
    const operations: string[] = [];
    const spawn = registrySpawn(fixture, tags, operations);

    await promoteExactRelease({
      sourceDirectory: fixture.source,
      artifactDirectory: fixture.artifacts,
      tag: "v0.1.0",
      commit,
      repository: "arduano/agent-multiplex",
      environment: { NODE_AUTH_TOKEN: "not-a-real-token" },
      spawn,
      wait: async () => {},
    });

    const firstAdd = operations.findIndex((operation) => operation.startsWith("add "));
    expect(firstAdd).toBeGreaterThan(
      operations.indexOf("view @arduano/agent-multiplex-two@0.1.0"),
    );
    expect(operations.filter((operation) => operation.startsWith("add "))).toEqual([
      "add @arduano/agent-multiplex-one@0.1.0",
      "add @arduano/agent-multiplex-two@0.1.0",
    ]);
    expect([...tags.values()]).toEqual([
      { next: "0.1.0", latest: "0.1.0" },
      { next: "0.1.0", latest: "0.1.0" },
    ]);
    expect(spawn.mock.calls
      .filter(([command]) => command === "npm")
      .filter(([, arguments_]) => arguments_[0] === "view")
      .every(([, arguments_]) => arguments_[1].endsWith("@0.1.0"))).toBe(true);
  });

  it("does not mutate any tag when a later package fails integrity preflight", async () => {
    const fixture = createFixture();
    fixture.packages[1].registryIntegrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const tags = new Map(fixture.packages.map(({ name }) => [name, { next: "0.1.0" }]));
    const operations: string[] = [];

    await expect(promoteExactRelease({
      sourceDirectory: fixture.source,
      artifactDirectory: fixture.artifacts,
      tag: "v0.1.0",
      commit,
      repository: "arduano/agent-multiplex",
      environment: { NODE_AUTH_TOKEN: "not-a-real-token" },
      spawn: registrySpawn(fixture, tags, operations),
      wait: async () => {},
    })).rejects.toThrow("registry SHA-512 integrity differs");

    expect(operations.some((operation) => operation.startsWith("add "))).toBe(false);
  });

  it("refuses to move latest backward", async () => {
    const fixture = createFixture();
    const tags = new Map(fixture.packages.map(({ name }) => [name, {
      next: "0.1.0",
      latest: "0.2.0",
    }]));
    const operations: string[] = [];

    await expect(promoteExactRelease({
      sourceDirectory: fixture.source,
      artifactDirectory: fixture.artifacts,
      tag: "v0.1.0",
      commit,
      repository: "arduano/agent-multiplex",
      environment: { NODE_AUTH_TOKEN: "not-a-real-token" },
      spawn: registrySpawn(fixture, tags, operations),
      wait: async () => {},
    })).rejects.toThrow("refusing to move latest backward");

    expect(operations.some((operation) => operation.startsWith("add "))).toBe(false);
  });

  it("rejects signed manifests outside the Agent Multiplex package namespace", async () => {
    const fixture = createFixture();
    writeJson(join(fixture.source, "release-packages.json"), {
      schemaVersion: 1,
      packages: [
        { workspace: "packages/one", name: "@arduano/agent-multiplex-one" },
        { workspace: "packages/two", name: "@arduano/unrelated-package" },
      ],
    });

    await expect(promoteExactRelease({
      sourceDirectory: fixture.source,
      artifactDirectory: fixture.artifacts,
      tag: "v0.1.0",
      commit,
      repository: "arduano/agent-multiplex",
      environment: { NODE_AUTH_TOKEN: "not-a-real-token" },
      spawn: registrySpawn(fixture, new Map(), []),
      wait: async () => {},
    })).rejects.toThrow("outside the Agent Multiplex namespace");
  });
});

describe("release semver ordering", () => {
  it("orders stable, prerelease, and large numeric versions", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.1.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("999999999999999999.0.0", "2.0.0")).toBeGreaterThan(0);
  });
});

function createFixture() {
  const source = mkdtempSync(join(tmpdir(), "agent-multiplex-promote-source-"));
  temporaryDirectories.push(source);
  const artifacts = join(source, "release-artifacts");
  mkdirSync(artifacts);
  writeJson(join(source, "package.json"), {
    version: "0.1.0",
    packageManager: "npm@11.17.0",
  });
  writeFileSync(join(source, ".node-version"), "24.19.0\n");
  const configured = [
    { workspace: "packages/one", name: "@arduano/agent-multiplex-one" },
    { workspace: "packages/two", name: "@arduano/agent-multiplex-two" },
  ];
  writeJson(join(source, "release-packages.json"), {
    schemaVersion: 1,
    packages: configured,
  });

  const packages = configured.map((entry) => {
    const workspace = join(source, entry.workspace);
    mkdirSync(workspace, { recursive: true });
    const packageManifest = { name: entry.name, version: "0.1.0", type: "module" };
    writeJson(join(workspace, "package.json"), packageManifest);
    const staging = mkdtempSync(join(tmpdir(), "agent-multiplex-promote-package-"));
    temporaryDirectories.push(staging);
    mkdirSync(join(staging, "package"));
    writeJson(join(staging, "package/package.json"), packageManifest);
    const filename = `${entry.name.replace(/^@/, "").replace("/", "-")}-0.1.0.tgz`;
    const path = join(artifacts, filename);
    execFileSync("tar", ["-czf", path, "package"], { cwd: staging });
    const bytes = readFileSync(path);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    return {
      ...entry,
      version: "0.1.0",
      filename,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      shasum: createHash("sha1").update(bytes).digest("hex"),
      integrity,
      registryIntegrity: integrity,
    };
  });
  writeJson(join(artifacts, "pack-manifest.json"), {
    schemaVersion: 2,
    repository: "arduano/agent-multiplex",
    commit,
    version: "0.1.0",
    toolchain: { node: "24.19.0", npm: "11.17.0" },
    packages,
  });
  writeFileSync(join(artifacts, "SHA256SUMS"), `${packages
    .map(({ sha256, filename }) => `${sha256}  ${filename}`)
    .join("\n")}\n`);
  return { source, artifacts, packages };
}

function registrySpawn(
  fixture: ReturnType<typeof createFixture>,
  tags: Map<string, { next: string; latest?: string }>,
  operations: string[],
) {
  return vi.fn((command: string, arguments_: string[]) => {
    if (command === "git") return { status: 0, stdout: `${commit}\n`, stderr: "" };
    const packageSpec = arguments_[1];
    const separator = packageSpec.lastIndexOf("@");
    const name = packageSpec.slice(0, separator);
    const artifact = fixture.packages.find((candidate) => candidate.name === name)!;
    if (arguments_[0] === "view") {
      operations.push(`view ${packageSpec}`);
      return {
        status: 0,
        stdout: JSON.stringify({
          "dist.integrity": artifact.registryIntegrity,
          "dist-tags": tags.get(name),
        }),
        stderr: "",
      };
    }
    if (arguments_[0] === "dist-tag" && arguments_[1] === "add") {
      const addSpec = arguments_[2];
      const addSeparator = addSpec.lastIndexOf("@");
      const addName = addSpec.slice(0, addSeparator);
      operations.push(`add ${addSpec}`);
      tags.get(addName)!.latest = "0.1.0";
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected command" };
  });
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
