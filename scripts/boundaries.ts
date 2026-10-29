import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, run } from "cmd-ts";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));

const contractFile = /(?:^|\/)(?:contracts|node-contracts|sdk-contracts)\.ts$/;
// Derived router inference and an acquired nominal capability are deliberate
// exceptions. Neither may be replaced by a hand-written structural facsimile.
const contractExceptions: Readonly<Record<string, readonly string[]>> = {
  "host/contracts.ts -> host/server/composition.ts": ["HostRouter"],
  "runtime/node-contracts.ts -> runtime/host-containment.ts": ["HostContainment"],
};

async function files(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await files(file)));
    else if (/\.(ts|tsx)$/.test(entry.name)) values.push(file);
  }
  return values;
}

async function checkBoundaries(): Promise<void> {
  const graph = new Map<string, string[]>();
  const builtins = new Map<string, string[]>();
  const computedImports = new Set<string>();
  const sources = new Set(await files(root));
  const sourceFile = (target: string) =>
    [target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx")].find((candidate) =>
      sources.has(candidate),
    );
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports?: unknown };
  const publicEntries = new Set<string>();
  function publicExports(value: unknown): void {
    if (typeof value === "string" && /^\.\/dist\/.+\.js$/.test(value)) {
      const entry = sourceFile(resolve(root, value.slice("./dist/".length)));
      assert(entry, `Missing source export: ${value}`);
      publicEntries.add(entry);
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) publicExports(nested);
    }
  }
  publicExports(manifest.exports);
  for (const file of sources) {
    const module = relative(root, file).split("/")[0];
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const dependencies: string[] = [];
    const nodeImports: string[] = [];
    graph.set(file, dependencies);
    builtins.set(file, nodeImports);
    function dependency(specifier: string, typeOnly: boolean, names: readonly string[] = []): void {
      assert(
        !specifier.includes("personal-multiplex") && !specifier.includes("leo-multiplex"),
        "A public module depends on a private app",
      );
      if (!typeOnly && specifier.startsWith("node:")) nodeImports.push(specifier);
      if (!specifier.startsWith(".")) return;
      const target = resolve(dirname(file), specifier);
      assert(!relative(root, target).startsWith(".."), `Import escapes source: ${file}`);
      const targetModule = relative(root, target).split("/")[0];
      const sourceTarget = sourceFile(target);
      assert(sourceTarget, `Missing source import: ${relative(root, file)} -> ${specifier}`);
      if (module !== targetModule && module !== "index.ts") {
        assert(
          publicEntries.has(sourceTarget) ||
            (relative(root, target).split("/").length === 2 &&
              /\/(?:index|contracts|node|node-contracts|sdk-contracts)\.js$/.test(target)),
          `Use a declared module entry: ${relative(root, file)} -> ${specifier}`,
        );
      }
      if (contractFile.test(file)) {
        const origin = relative(root, file),
          destination = relative(root, sourceTarget);
        const allowed = contractExceptions[`${origin} -> ${destination}`];
        assert(
          contractFile.test(sourceTarget) ||
            destination === "protocol/index.ts" ||
            !!(
              allowed &&
              typeOnly &&
              names.length &&
              names.every((name) => allowed.includes(name))
            ),
          `Contract reaches implementation: ${origin} -> ${destination}`,
        );
      }
      if (!typeOnly) dependencies.push(sourceTarget);
    }
    function visitNode(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const value = node.moduleSpecifier;
        if (value && ts.isStringLiteral(value)) {
          // With verbatimModuleSyntax, named `type` bindings still emit an
          // empty runtime import/export. Only declaration-level type erases.
          const typeOnly = ts.isImportDeclaration(node)
            ? node.importClause?.isTypeOnly === true
            : node.isTypeOnly;
          const bindings = ts.isImportDeclaration(node)
            ? node.importClause?.namedBindings
            : node.exportClause;
          const names =
            bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
              ? bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
              : [];
          dependency(value.text, typeOnly, names);
        }
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        dependency(
          node.argument.literal.text,
          true,
          node.qualifier ? [node.qualifier.getText(source)] : [],
        );
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const value = node.arguments[0];
        if (value && ts.isStringLiteralLike(value)) dependency(value.text, false);
        else computedImports.add(file);
      }
      ts.forEachChild(node, visitNode);
    }
    visitNode(source);
  }
  const active = new Set<string>(),
    seen = new Set<string>();
  function visit(file: string): void {
    assert(!active.has(file), `Runtime import cycle at ${relative(root, file)}`);
    if (seen.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    active.delete(file);
    seen.add(file);
  }
  for (const file of graph.keys()) visit(file);

  const portableRoots = new Set<string>();
  function collectExports(value: unknown): void {
    if (typeof value === "string") {
      if (!value.endsWith(".js")) return;
      assert(/^\.\/dist\/.+\.js$/.test(value), `Unsupported JavaScript export: ${value}`);
      const entry = sourceFile(resolve(root, value.slice("./dist/".length)));
      assert(entry, `Missing source export: ${value}`);
      portableRoots.add(entry);
    } else if (Array.isArray(value)) {
      for (const item of value) collectExports(item);
    } else if (value && typeof value === "object") {
      for (const [condition, target] of Object.entries(value)) {
        if (condition !== "node" && condition !== "types") collectExports(target);
      }
    }
  }
  collectExports(manifest.exports);
  const portable = new Set<string>();
  function visitPortable(file: string, entry: string): void {
    if (portable.has(file)) return;
    const path = relative(root, file);
    const context = `${relative(root, entry)} -> ${path}`;
    assert(
      !path.split("/").includes("server"),
      `Portable export reaches server implementation: ${context}`,
    );
    assert(
      !path.split("/").includes("node"),
      `Portable export reaches Node implementation: ${context}`,
    );
    assert(!/(?:^|\/)node\.tsx?$/.test(path), `Portable export reaches Node facade: ${context}`);
    assert(
      !computedImports.has(file),
      `Portable export reaches computed dynamic import: ${context}`,
    );
    assert(
      !builtins.get(file)?.length,
      `Portable export reaches Node builtin: ${context} -> ${builtins.get(file)?.join(", ")}`,
    );
    portable.add(file);
    for (const dependency of graph.get(file) ?? []) visitPortable(dependency, entry);
  }
  for (const entry of portableRoots) visitPortable(entry, entry);
  console.log(
    `Source boundaries passed (${graph.size} modules, ${portableRoots.size} portable exports checked).`,
  );
}

await run(
  command({
    name: "multiplex-boundaries",
    description: "Check public source entry points, portable runtime closures and runtime cycles.",
    args: {},
    handler: checkBoundaries,
  }),
  process.argv.slice(2),
);
