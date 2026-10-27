import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";

/** Complete packaged directory closure; paths never resolve through a sibling checkout. */
export type SkillAssets = Readonly<{
  directory: string;
  files: readonly Readonly<{ path: string; sha256: string; bytes: number; executable?: boolean }>[];
}>;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export function validateSkillAssets(value: SkillAssets): SkillAssets {
  requireThat(isAbsolute(value.directory) && value.files.length > 0 && value.files.length <= 128);
  const names = new Set<string>(); let total = 0;
  for (const file of value.files) {
    requireThat(file.path.split("/").every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..") && !names.has(file.path)); names.add(file.path);
    requireThat(/^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 1024 * 1024 && (total += file.bytes) <= 8 * 1024 * 1024 && (file.executable === undefined || typeof file.executable === "boolean"));
  }
  requireThat(value.files.some(file => /^[^/]+\/SKILL\.md$/.test(file.path)), "Skill bundle must contain a named skill/SKILL.md");
  return copy(value);
}
async function exactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  requireThat((await lstat(path)).isDirectory() && ((await lstat(path)).mode & 0o077) === 0 && !(await lstat(path)).isSymbolicLink() && await realpath(path) === resolve(path), "Skill directory is not an exact private path");
}
/** Verify complete source closure and copy immutable bytes into the owned native
 * home. Existing different files refuse; an update never overwrites managed state. */
export async function provisionSkillAssets(assets: SkillAssets, nativeHome: string, bundle: string): Promise<string> {
  const fixed = validateSkillAssets(assets); requireThat(isAbsolute(nativeHome) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bundle));
  requireThat(await realpath(fixed.directory) === resolve(fixed.directory) && !(await lstat(fixed.directory)).isSymbolicLink());
  const expected = new Map(fixed.files.map(file => [file.path, file])), bodies = new Map<string, Uint8Array>(); let visited = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      requireThat(++visited <= 256 && !entry.isSymbolicLink()); const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { requireThat(path.split("/").length <= 12); await walk(join(directory, entry.name), path); }
      else {
        const metadata = expected.get(path); requireThat(entry.isFile() && metadata, "Unlisted skill asset");
        const absolute = join(directory, entry.name), stat = await lstat(absolute); requireThat(stat.size === metadata.bytes && !!(stat.mode & 0o111) === !!metadata.executable, "Skill asset metadata differs");
        const body = await readFile(absolute); requireThat(hash(body) === metadata.sha256, "Skill asset digest differs"); bodies.set(path, body);
      }
    }
  };
  await walk(fixed.directory, ""); requireThat(bodies.size === fixed.files.length, "Skill asset is missing");
  const target = join(nativeHome, "contributions", "skills", bundle);
  // Establish each parent explicitly before writing. No source symlinks, opaque
  // directory copies, optional missing files or implicit discovery are accepted.
  for (const path of [nativeHome, join(nativeHome, "contributions"), join(nativeHome, "contributions", "skills"), target]) await exactDirectory(path);
  const manifest = canonical(fixed.files, 65536), manifestFile = join(nativeHome, "contributions", "skills", `${bundle}.manifest.json`);
  try { await writeFile(manifestFile, manifest, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await lstat(manifestFile); requireThat(stat.isFile() && !stat.isSymbolicLink() && await readFile(manifestFile, "utf8") === manifest, "Managed skill installation changed; explicit migration is required");
  }
  for (const file of fixed.files) {
    const destination = join(target, file.path), parents = file.path.split("/").slice(0, -1); let parent = target;
    for (const part of parents) { parent = join(parent, part); await exactDirectory(parent); }
    const body = bodies.get(file.path)!;
    try { await writeFile(destination, body, { flag: "wx", mode: file.executable ? 0o700 : 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(destination); requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size === file.bytes && hash(await readFile(destination)) === file.sha256 && !!(stat.mode & 0o111) === !!file.executable, "Existing managed skill differs");
    }
  }
  return target;
}
