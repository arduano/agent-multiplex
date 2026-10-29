import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import ts from "typescript";

test("public React/chat contracts compile with Node ambient declarations unavailable", () => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    types: [],
    noEmit: true,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options),
    get = host.getSourceFile.bind(host),
    exists = host.fileExists.bind(host),
    read = host.readFile.bind(host);
  const denied = (file: string) => file.replaceAll("\\", "/").includes("/@types/node/");
  host.fileExists = (file) => !denied(file) && exists(file);
  host.readFile = (file) => (denied(file) ? undefined : read(file));
  host.getSourceFile = (file, ...args) => (denied(file) ? undefined : get(file, ...args));
  const program = ts.createProgram(
    [
      resolve("src/react/index.ts"),
      resolve("src/chat/index.ts"),
      resolve("src/attachments/index.ts"),
      resolve("src/child-streams/index.ts"),
    ],
    options,
    host,
  );
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
});
