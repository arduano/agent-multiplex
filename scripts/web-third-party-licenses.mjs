import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repositoryRoot, "apps/web");
const defaultBundleRoot = resolve(webRoot, "dist/client");
const defaultOutput = resolve(webRoot, "THIRD_PARTY_LICENSES.txt");
const defaultBundleOutput = resolve(defaultBundleRoot, "THIRD_PARTY_LICENSES.txt");

// Fontsource and Tailwind inputs are transformed into CSS and WOFF2 assets
// rather than represented as JavaScript source-map entries. Keep them explicit
// so a Vite/Rollup source-map shape cannot make their licenses disappear.
const embeddedAssetPackages = Object.freeze([
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "tailwindcss",
]);

// react-remove-scroll-bar@2.3.8 declares MIT but omitted the LICENSE file from
// its npm archive. This is the upstream repository LICENSE at the pinned commit
// recorded below; keeping the copy in-tree makes generation network-independent.
const licenseOverrides = Object.freeze({
  "react-remove-scroll-bar@2.3.8": {
    filename: "LICENSE",
    path: resolve(
      webRoot,
      "license-inputs/react-remove-scroll-bar-2.3.8-LICENSE.txt",
    ),
    source:
      "https://github.com/theKashey/react-remove-scroll-bar/blob/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE",
  },
});

export function renderWebThirdPartyLicenses(bundleRoot = defaultBundleRoot) {
  const bundledPackages = discoverBundledPackages(bundleRoot);
  for (const packageName of embeddedAssetPackages) {
    const root = realpathSync(resolve(repositoryRoot, "node_modules", packageName));
    if (!bundledPackages.has(root)) bundledPackages.set(root, new Set());
  }

  const packages = [...bundledPackages]
    .map(([root, sourceNotices]) => readPackageLicense(root, sourceNotices))
    .sort((left, right) => compareText(left.identity, right.identity));
  const groups = new Map();
  for (const entry of packages) {
    const documentBody = entry.documents
      .map(({ filename, contents }) => `--- ${filename} ---\n\n${contents}`)
      .join("\n\n");
    const key = createHash("sha256").update(documentBody).digest("hex");
    const group = groups.get(key) ?? { documentBody, packages: [] };
    group.packages.push(entry);
    groups.set(key, group);
  }

  const sections = [...groups.values()]
    .sort((left, right) =>
      compareText(left.packages[0].identity, right.packages[0].identity))
    .map(({ documentBody, packages: entries }, index) => {
      const components = entries.map(({ identity, declaredLicense, overrideSource }) =>
        `- ${identity} (declared license: ${declaredLicense})${
          overrideSource ? `; license source: ${overrideSource}` : ""
        }`).join("\n");
      return [
        "===============================================================================",
        `License group ${index + 1}`,
        "",
        "Components:",
        components,
        "",
        documentBody,
      ].join("\n");
    });

  return [
    "Agent Multiplex web bundle: third-party licenses",
    "",
    "This file accompanies the compiled browser JavaScript, CSS, icons, and font",
    "software in @arduano/agent-multiplex-web. Component identities are derived",
    "from the shipped JavaScript source maps plus the explicitly embedded CSS",
    "and font inputs. Identical upstream license documents are grouped without",
    "changing their text. BUNDLED-SOURCE-NOTICES sections preserve license and",
    "copyright comments that production minification removes. Agent Multiplex's",
    "own MIT license is in the package LICENSE file.",
    "",
    `Component packages: ${packages.length}`,
    "",
    ...sections,
    "",
  ].join("\n");
}

/** Exact npm identities whose code or assets occur in the compiled web output. */
export function bundledWebPackageIdentities(bundleRoot = defaultBundleRoot) {
  const bundledPackages = discoverBundledPackages(bundleRoot);
  for (const packageName of embeddedAssetPackages) {
    const root = realpathSync(resolve(repositoryRoot, "node_modules", packageName));
    if (!bundledPackages.has(root)) bundledPackages.set(root, new Set());
  }
  return [...bundledPackages.keys()]
    .map((root) => {
      const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      assert(
        typeof manifest.name === "string" && typeof manifest.version === "string",
        `${relative(repositoryRoot, root)} has invalid package identity`,
      );
      return `${manifest.name}@${manifest.version}`;
    })
    .sort(compareText);
}

export function assertWebThirdPartyLicensesCurrent({
  bundleRoot = defaultBundleRoot,
  output = defaultOutput,
} = {}) {
  assert(existsSync(output), `${relative(repositoryRoot, output)} is missing`);
  const expected = renderWebThirdPartyLicenses(bundleRoot);
  const actual = readFileSync(output, "utf8").replaceAll("\r\n", "\n");
  assert(
    actual === expected,
    `${relative(repositoryRoot, output)} does not match the built web bundle; ` +
      "run `node scripts/web-third-party-licenses.mjs --write` after building the web client",
  );
  const bundleOutput = resolve(bundleRoot, "THIRD_PARTY_LICENSES.txt");
  assert(
    existsSync(bundleOutput),
    `${relative(repositoryRoot, bundleOutput)} is missing`,
  );
  const bundleCopy = readFileSync(bundleOutput, "utf8").replaceAll("\r\n", "\n");
  assert(
    bundleCopy === expected,
    `${relative(repositoryRoot, bundleOutput)} does not match the built web bundle`,
  );
  return {
    bytes: Buffer.byteLength(actual),
    sha256: createHash("sha256").update(actual).digest("hex"),
  };
}

function discoverBundledPackages(bundleRoot) {
  assert(
    existsSync(bundleRoot) && statSync(bundleRoot).isDirectory(),
    `${relative(repositoryRoot, bundleRoot)} is missing; build the web client first`,
  );
  const maps = walk(bundleRoot).filter((path) => path.endsWith(".js.map"));
  assert(maps.length > 0, "the web bundle has no JavaScript source maps");

  const packages = new Map();
  for (const mapPath of maps) {
    const sourceMap = JSON.parse(readFileSync(mapPath, "utf8"));
    assert(
      Array.isArray(sourceMap.sources),
      `${relative(repositoryRoot, mapPath)} has no sources`,
    );
    for (const [index, source] of sourceMap.sources.entries()) {
      if (typeof source !== "string") continue;
      const root = packageRootForSource(mapPath, sourceMap.sourceRoot, source);
      if (root === undefined) continue;
      const realRoot = realpathSync(root);
      const notices = packages.get(realRoot) ?? new Set();
      const sourceContents = sourceMap.sourcesContent?.[index];
      if (typeof sourceContents === "string") {
        for (const notice of extractSourceNotices(sourceContents)) {
          notices.add(notice);
        }
      }
      packages.set(realRoot, notices);
    }
  }
  assert(packages.size > 0, "the web bundle has no discoverable third-party packages");
  return packages;
}

function packageRootForSource(mapPath, sourceRoot, source) {
  const cleanSource = source.split(/[?#]/u, 1)[0];
  const absolute = resolve(
    dirname(mapPath),
    typeof sourceRoot === "string" ? sourceRoot : "",
    cleanSource,
  );
  const segments = absolute.split(/[\\/]/u);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return undefined;
  const first = segments[nodeModulesIndex + 1];
  assert(first, `invalid node_modules source ${source}`);
  const packageSegments = first.startsWith("@")
    ? [first, segments[nodeModulesIndex + 2]]
    : [first];
  assert(packageSegments.every(Boolean), `invalid scoped package source ${source}`);
  const root = resolve(
    segments.slice(0, nodeModulesIndex + 1).join("/"),
    ...packageSegments,
  );
  assert(
    existsSync(resolve(root, "package.json")),
    `package metadata is missing for source ${source}`,
  );
  return root;
}

function readPackageLicense(root, sourceNotices) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert(
    typeof manifest.name === "string" && typeof manifest.version === "string",
    `${relative(repositoryRoot, root)} has invalid package identity`,
  );
  assert(
    typeof manifest.license === "string" && manifest.license.length > 0,
    `${manifest.name}@${manifest.version} does not declare a license`,
  );
  const identity = `${manifest.name}@${manifest.version}`;
  const override = licenseOverrides[identity];
  let documents;
  if (override !== undefined) {
    assert(
      existsSync(override.path),
      `${relative(repositoryRoot, override.path)} is missing`,
    );
    documents = [{
      filename: override.filename,
      contents: normalizeDocument(readFileSync(override.path, "utf8")),
    }];
  } else {
    const filenames = readdirSync(root).filter((filename) =>
      /^(?:licen[cs]e|copying|notice)(?:$|[._-])/iu.test(filename) &&
      statSync(resolve(root, filename)).isFile()).sort();
    assert(
      filenames.length > 0,
      `${identity} has no redistributable license document`,
    );
    documents = filenames.map((filename) => ({
      filename,
      contents: normalizeDocument(readFileSync(resolve(root, filename), "utf8")),
    }));
  }
  if (sourceNotices.size > 0) {
    documents.push({
      filename: "BUNDLED-SOURCE-NOTICES",
      contents: [...sourceNotices].sort(compareText).join("\n\n"),
    });
  }
  return {
    identity,
    declaredLicense: manifest.license,
    documents,
    ...(override ? { overrideSource: override.source } : {}),
  };
}

function normalizeDocument(contents) {
  const normalized = contents.replaceAll("\r\n", "\n").trim();
  assert(normalized.length > 0, "empty third-party license document");
  return normalized;
}

function extractSourceNotices(contents) {
  const notices = [];
  const prelude = contents.slice(0, 4_096);
  for (const match of prelude.matchAll(/\/\*[\s\S]*?\*\//gu)) {
    if ((match.index ?? 0) > 1_024) break;
    if (/@license|copyright/iu.test(match[0])) {
      notices.push(normalizeDocument(match[0]));
    }
  }
  return notices;
}

function walk(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output.sort();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const write = process.argv.includes("--write");
  const output = process.argv.find((argument, index) =>
    index > 1 && argument !== "--write" && argument !== "--check");
  const outputPath = output ? resolve(repositoryRoot, output) : defaultOutput;
  if (write) {
    const contents = renderWebThirdPartyLicenses();
    writeFileSync(outputPath, contents, { mode: 0o644 });
    if (!output) writeFileSync(defaultBundleOutput, contents, { mode: 0o644 });
    console.log(
      `Wrote ${relative(repositoryRoot, outputPath)}${
        output ? "" : ` and ${relative(repositoryRoot, defaultBundleOutput)}`
      } ` +
        `(${Buffer.byteLength(contents)} bytes).`,
    );
  } else {
    const result = assertWebThirdPartyLicensesCurrent({ output: outputPath });
    console.log(
      `Web third-party licenses are current (${result.bytes} bytes, sha256 ${result.sha256}).`,
    );
  }
}
