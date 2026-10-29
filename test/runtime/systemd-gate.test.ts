import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateMain, parseGateArguments } from "../../src/runtime/systemd-gate.js";

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error("Fixture boundary did not arrive");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("internal cmd-ts commands validate before any custody/configuration reads", async () => {
  for (const command of ["gate", "delegated-gate"] as const) {
    assert.deepEqual(await parseGateArguments([command, "/explicit/private/gate"]), {
      command,
      directory: "/explicit/private/gate",
    });
    assert.equal((await parseGateArguments([command, "--help"])).command, "help");
    await assert.rejects(gateMain([command]));
    await assert.rejects(gateMain([command, "directory", "extra"]));
  }
  assert.equal((await parseGateArguments([])).command, "help");
  await assert.rejects(gateMain(["--gate", "directory"]));
  await assert.rejects(gateMain(["--delegated-gate", "directory"]));
});

test(
  "actual gate contains a child's broken stdin, preserves stdout framing and waits for actual child exit",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "v8-gate-")),
      script = join(directory, "child.js"),
      completed = join(directory, "completed");
    await writeFile(
      script,
      `import {closeSync,writeFileSync} from 'node:fs'; closeSync(0); process.stdout.write('child-ready\\n'); setTimeout(()=>{writeFileSync(${JSON.stringify(completed)},'done');process.exit(0)},500);\n`,
    );
    const cgroup = (await readFile("/proc/self/cgroup", "utf8"))
        .trim()
        .split("\n")
        .find((line) => line.startsWith("0::"))!
        .slice(3),
      invocation = "scripted-gate-only";
    await writeFile(
      join(directory, "gate.json"),
      JSON.stringify({
        binary: process.execPath,
        args: [script],
        cwd: directory,
        environment: { PATH: "/usr/bin:/bin", HOME: directory },
        nonce: "fixture-nonce",
      }),
    );
    await writeFile(
      join(directory, "allocation.json"),
      JSON.stringify({
        invocation,
        cgroup,
        bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      }),
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../src/runtime/systemd-gate.js", import.meta.url)),
        "gate",
        directory,
      ],
      { env: { ...process.env, INVOCATION_ID: invocation }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "",
      stdout = "",
      status: number | null | undefined;
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        status = code;
        resolve();
      });
    });
    let socket: ReturnType<typeof createConnection> | undefined,
      native = "";
    try {
      await until(() => exists(join(directory, "gate-ready")));
      socket = createConnection(join(directory, "gate.sock"));
      socket.on("error", () => {});
      socket.on("data", (data) => {
        native += data.toString();
      });
      await new Promise<void>((resolve, reject) => {
        socket!.once("connect", resolve);
        socket!.once("error", reject);
      });
      socket.write(JSON.stringify({ nonce: "fixture-nonce", args: [script] }) + "\n");
      await until(() => native === "child-ready\n");
      socket.write(Buffer.alloc(1024 * 1024, 65));
      await exited;
      assert.equal(status, 0);
      assert.equal(await exists(completed), true, "Broken observation cannot stop the child");
      assert.equal(native, "child-ready\n");
      assert.equal(stdout, "", "Gate diagnostics never corrupt native RPC stdout");
      const facts = stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(facts.some((value) => value.event === "stdio-error" && value.code === "EPIPE"));
      assert.ok(
        facts.some(
          (value) => value.event === "child-exit" && value.code === 0 && value.signal === null,
        ),
      );
      assert.equal(stderr.includes(directory), false);
      assert.equal(stderr.includes("Unhandled"), false);
    } finally {
      socket?.destroy();
      if (status === undefined) {
        child.kill("SIGKILL");
        await exited.catch(() => {});
      }
      // The scripted child is finite even if the pre-fix gate crashes first.
      await until(() => exists(completed)).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "fixed host launcher receives the original native executable and args while SDK authentication stays unchanged",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "v8-gate-loader-"));
    const marker = join(directory, "loader-used"),
      native = join(directory, "native.js"),
      loader = join(directory, "loader.js"),
      driver = join(directory, "driver.js");
    const helper = fileURLToPath(new URL("../../src/runtime/systemd-gate.js", import.meta.url));
    const args = [native, "space preserved", "--native-flag"];
    await writeFile(native, "process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');\n");
    await writeFile(
      loader,
      `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const [marker,binary,...args]=process.argv.slice(2);writeFileSync(marker,JSON.stringify([binary,...args]));const child=spawn(binary,args,{stdio:'inherit'});child.once('exit',code=>{process.exitCode=code??1});\n`,
    );
    await writeFile(
      driver,
      `import {runSystemdLauncher} from ${JSON.stringify(new URL("../../src/runtime/systemd-gate.js", import.meta.url).href)};await runSystemdLauncher(${JSON.stringify(directory)},process.argv.slice(2));\n`,
    );
    const cgroup = (await readFile("/proc/self/cgroup", "utf8"))
        .trim()
        .split("\n")
        .find((line) => line.startsWith("0::"))!
        .slice(3),
      invocation = "scripted-loader-only";
    await writeFile(
      join(directory, "gate.json"),
      JSON.stringify({
        binary: process.execPath,
        args,
        cwd: directory,
        environment: { PATH: "/usr/bin:/bin" },
        nonce: "loader-fixture",
        launcher: { binary: process.execPath, args: [loader, marker] },
      }),
    );
    await writeFile(
      join(directory, "allocation.json"),
      JSON.stringify({
        invocation,
        cgroup,
        bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      }),
    );
    const gate = spawn(process.execPath, [helper, "gate", directory], {
      env: { ...process.env, INVOCATION_ID: invocation },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let client: ReturnType<typeof spawn> | undefined,
      output = "",
      gateStatus: number | null | undefined,
      clientStatus: number | null | undefined;
    gate.stdout!.on("data", () => {});
    gate.stderr!.on("data", () => {});
    gate.once("exit", (value) => {
      gateStatus = value;
    });
    try {
      await until(() => exists(join(directory, "gate-ready")));
      client = spawn(process.execPath, [driver, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      client.stdout!.on("data", (value) => {
        output += value;
      });
      client.stderr!.on("data", () => {});
      client.once("exit", (value) => {
        clientStatus = value;
      });
      await until(() => gateStatus !== undefined && clientStatus !== undefined);
      assert.equal(gateStatus, 0);
      assert.equal(clientStatus, 0);
      assert.equal(output, JSON.stringify(args.slice(1)) + "\n");
      assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), [process.execPath, ...args]);
      assert.equal(await exists(join(directory, "gate-admitted")), true);
    } finally {
      for (const child of [client, gate])
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(
        [client, gate]
          .filter((child): child is NonNullable<typeof child> => !!child)
          .map((child) =>
            child.exitCode !== null || child.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((resolve) => child.once("close", () => resolve())),
          ),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
