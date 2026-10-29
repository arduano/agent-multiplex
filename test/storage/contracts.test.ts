import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

test("borrowed journal contracts are structural, synchronous and independent of Node", () => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    types: [],
    noEmit: true,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options),
    source = host.getSourceFile.bind(host),
    exists = host.fileExists.bind(host),
    read = host.readFile.bind(host);
  const denied = (file: string) => file.replaceAll("\\", "/").includes("/@types/node/");
  host.fileExists = (file) => !denied(file) && exists(file);
  host.readFile = (file) => (denied(file) ? undefined : read(file));
  host.getSourceFile = (file, ...args) => (denied(file) ? undefined : source(file, ...args));
  const program = ts.createProgram([resolve("test/storage/portable.ts")], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }),
  );
  assert(!program.getSourceFiles().some((file) => denied(file.fileName)));
  assert(!program.getSourceFiles().some((file) => file.fileName.endsWith("/storage/sqlite.ts")));
});
