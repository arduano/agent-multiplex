import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, parseArguments } from "../../src/reference/cli.js";

test("cmd-ts owns both commands, conventional port options and inert help", async () => {
  assert.deepEqual(await parseArguments(["demo"]), { command: "demo", port: 0 });
  assert.deepEqual(await parseArguments(["demo", "--port=65535"]), {
    command: "demo",
    port: 65535,
  });
  assert.deepEqual(
    await parseArguments(["run", "application.tsx", "agent data", "system data", "--port", "1234"]),
    {
      command: "run",
      application: "application.tsx",
      agentsDirectory: "agent data",
      systemDirectory: "system data",
      port: 1234,
    },
  );
  assert.deepEqual(
    await parseArguments(["run", "--port=0", "application.ts", "agents", "system"]),
    {
      command: "run",
      application: "application.ts",
      agentsDirectory: "agents",
      systemDirectory: "system",
      port: 0,
    },
  );
  for (const args of [[], ["--help"], ["demo", "--help"], ["run", "--help"]]) {
    const parsed = await parseArguments(args);
    assert.equal(parsed.command, "help");
    if (parsed.command === "help") assert.match(parsed.message, /multiplex/);
  }
});

test("invalid syntax and ports never import the application, create state or install shutdown handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-cli-parse-"));
  const application = join(directory, "application.tsx"),
    agents = join(directory, "agents"),
    system = join(directory, "system");
  await writeFile(application, 'throw Error("APPLICATION_MUST_NOT_IMPORT");\n');
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    for (const value of ["-1", "65536", "1.5", "NaN", "", " ", "1e2", "0x50"]) {
      await assert.rejects(
        main(["run", application, agents, system, "--port", value]),
        /Port must be an integer/,
      );
      await assert.rejects(parseArguments(["demo", "--port", value]), /Port must be an integer/);
    }
    for (const args of [
      ["unknown"],
      ["demo", "--unknown"],
      ["demo", "--port"],
      ["demo", "--port="],
      ["demo", "17"],
      ["run", application, agents],
      ["run", application, agents, system, "17"],
      ["run", "", agents, system],
      ["run", application, agents, system, "--port", "1", "--port", "2"],
    ])
      await assert.rejects(main(args));
    assert.deepEqual(await readdir(directory), ["application.tsx"]);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled CLI import/help cannot exit the caller or start a transpiler/native subprocess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-cli-help-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const forbidden=()=>{throw Error("SUBPROCESS_FORBIDDEN_DURING_HELP");};
      for(const key of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"])childProcess[key]=forbidden;
      syncBuiltinESMExports();
      process.exit=()=>{throw Error("PROCESS_EXIT_FORBIDDEN");};
      const before=[process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")];
      const cli=await import(process.argv[1]);
      await cli.main(["--help"]);
      await cli.main(["run","--help"]);
      await assert.rejects(cli.main(["unknown"]));
      assert.deepEqual([process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")],before);
    `,
        new URL("../../src/reference/cli.js", import.meta.url).href,
      ],
      {
        cwd: directory,
        env: { HOME: directory, PATH: "", NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /model-free/);
    assert.match(child.stdout, /explicit application/);
    assert.match(child.stdout, /--port/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plain Node CLI lazily loads an explicit TypeScript/JSX application before any listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-cli-tsx-"));
  const application = join(directory, "application.tsx"),
    agents = join(directory, "agents"),
    system = join(directory, "system");
  try {
    await writeFile(
      application,
      `
      /** @jsxRuntime classic */
      /** @jsx element */
      function element(name: string) { return name; }
      export async function create({paths}: {paths: {agents: string; system: string}}) {
        const rendered = <fixture />;
        if (rendered !== "fixture" || paths.agents === paths.system) throw Error("BAD_TSX_OR_STATE_PATHS");
        throw Error("TSX_CREATE_REACHED_BEFORE_LISTENER");
      }
    `,
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const cli=await import(process.argv[1]);
      const before=[process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")];
      await assert.rejects(cli.main(["run",...process.argv.slice(2),"--port","0"]),/TSX_CREATE_REACHED_BEFORE_LISTENER/);
      assert.deepEqual([process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")],before);
    `,
        new URL("../../src/reference/cli.js", import.meta.url).href,
        application,
        agents,
        system,
      ],
      {
        env: { ...process.env, HOME: directory, TSX_DISABLE_CACHE: "1" },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(await readdir(directory), ["agents", "application.tsx", "system"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
