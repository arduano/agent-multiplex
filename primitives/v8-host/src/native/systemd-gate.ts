/** Internal installed helper. A gate is a native custody resource, never a session owner. */
import { createServer, createConnection } from "node:net";
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { existsSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GateConfiguration = Readonly<{
  binary: string; args: readonly string[]; cwd: string;
  environment: Readonly<Record<string, string>>; nonce: string;
  /** Trusted host-selected OS launcher; SDK authentication still uses args. */
  launcher?: Readonly<{ binary: string; args: readonly string[] }>;
}>;
const configuration = (directory: string): GateConfiguration => JSON.parse(readFileSync(join(directory, "gate.json"), "utf8")) as GateConfiguration;
const sealed = (directory: string): boolean => existsSync(join(directory, "sealed"));
async function privateSocket(directory: string, use: (address: string) => Promise<void>): Promise<void> {
  // AF_UNIX has a short address limit even when the private custody directory
  // is a normal deep session path. Each process pins that same directory and
  // addresses its filesystem socket through its own short descriptor path.
  const descriptor = openSync(directory, "r");
  try { await use(`/proc/self/fd/${descriptor}/gate.sock`); }
  finally { closeSync(descriptor); }
}

/** Called only by the SDK's fixed launcher, after its opening capsule was saved. */
export async function runSystemdLauncher(directory: string, args: readonly string[]): Promise<void> {
  const config = configuration(directory);
  if (sealed(directory) || JSON.stringify(args) !== JSON.stringify(config.args)) throw Error("Native gate launch is fenced");
  // Opening custody has already reached SessionHost before this launcher runs.
  // Gate readiness is observation, never another unit or native launch.
  const deadline = Date.now() + 5000;
  while (!existsSync(join(directory, "gate-ready"))) {
    if (sealed(directory) || Date.now() >= deadline) throw Error("Native gate readiness is unconfirmed");
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 20));
  }
  closeSync(openSync(join(directory, "launch-claimed"), "wx", 0o600));
  if (sealed(directory)) throw Error("Native gate launch is sealed");
  await privateSocket(directory, async address => {
    const socket = createConnection(address);
    await new Promise<void>((resolveConnected, reject) => { socket.once("connect", resolveConnected); socket.once("error", reject); });
    socket.write(JSON.stringify({ nonce: config.nonce, args }) + "\n");
    // Native stdout alone crosses this socket. Native stderr stays in the private
    // user service journal and cannot corrupt the vendor's JSON-RPC stdout.
    socket.pipe(process.stdout); process.stdin.pipe(socket);
    await new Promise<void>((resolveClosed, reject) => { socket.once("close", resolveClosed); socket.once("error", reject); });
  });
}

/** Starts no vendor process until the one-shot authenticated launcher arrives. */
export async function runSystemdGate(directory: string): Promise<void> {
  const config = configuration(directory);
  let admitted = false;
  await privateSocket(directory, async address => {
  const server = createServer(socket => {
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    const data = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if ((newline < 0 ? header.length > 16384 : newline > 16384) || admitted || sealed(directory)) { socket.destroy(); return; }
      if (newline < 0) return;
      clearTimeout(timer); socket.off("data", data);
      try {
        const request = JSON.parse(header.subarray(0, newline).toString()) as { nonce?: unknown; args?: unknown };
        if (request.nonce !== config.nonce || JSON.stringify(request.args) !== JSON.stringify(config.args)) throw Error("Gate authentication failed");
        const receipt = JSON.parse(readFileSync(join(directory, "allocation.json"), "utf8")) as { invocation: string; cgroup: string; bootId: string };
        const ownCgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
        if (receipt.invocation !== process.env.INVOCATION_ID || receipt.cgroup !== ownCgroup || receipt.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || sealed(directory)) throw Error("Gate allocation identity changed");
        closeSync(openSync(join(directory, "gate-admitted"), "wx", 0o600)); admitted = true;
        // This synchronous check/spawn is enclosed by the live service cgroup.
        // Concurrent Stop seals first and retires that entire cgroup, including
        // a child born while the manager's stop job is taking effect.
        if (sealed(directory)) throw Error("Gate acquisition sealed");
        const binary = config.launcher?.binary ?? config.binary;
        const args = config.launcher ? [...config.launcher.args, config.binary, ...config.args] : [...config.args];
        const child = spawn(binary, args, { cwd: config.cwd, env: { ...config.environment }, stdio: ["pipe", "pipe", "inherit"] });
        const code = (error: unknown): string => {
          const value = (error as NodeJS.ErrnoException | null)?.code;
          return typeof value === "string" && ["EPIPE", "ECONNRESET", "ENOENT", "EACCES", "EPERM", "ENOEXEC", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "ENOTDIR", "ETXTBSY", "E2BIG"].includes(value) ? value : "unknown";
        };
        const report = (event: string, detail: Readonly<Record<string, string | number | null>>) => {
          // Closed process facts only. Native stderr remains inherited; never
          // serialize argv, configuration, native messages or Error.message.
          process.stderr.write(JSON.stringify({source: "multiplex.native-gate", event, ...detail}) + "\n");
        };
        const disconnect = (error: unknown) => {
          report("stdio-error", {code: code(error)}); socket.unpipe(child.stdin); socket.destroy();
          // A broken RPC pipe cannot release native custody or kill the child.
          // Keep draining stdout until actual child exit or explicit unit Stop.
          child.stdout.unpipe(socket); child.stdout.resume();
        };
        // Install before writing the buffered header tail or piping more input:
        // a child can close stdin before its startup handshake completes.
        child.stdin.once("error", disconnect); child.stdout.once("error", disconnect);
        child.once("error", error => { report("child-error", {code: code(error)}); socket.destroy(); process.exitCode = 1; server.close(); });
        const tail = header.subarray(newline + 1); if (tail.length) child.stdin.write(tail);
        socket.pipe(child.stdin); child.stdout.pipe(socket);
        child.once("exit", (code, signal) => { report("child-exit", {code, signal: signal && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null}); socket.end(); process.exitCode = code ?? 1; server.close(); });
      } catch { socket.destroy(); }
    };
    socket.once("close", () => clearTimeout(timer)); socket.on("error", () => {}); socket.on("data", data);
  });
  await new Promise<void>((resolveListening, reject) => { server.once("error", reject); server.listen(address, resolveListening); });
  await chmod(join(directory, "gate.sock"), 0o600);
  // Readiness is a private marker; no stdout, credentials or native handshake.
  writeFileSync(join(directory, "gate-ready"), "ready\n", { mode: 0o600, flag: "wx" });
  await new Promise<void>((resolveClosed, reject) => { server.once("close", resolveClosed); server.once("error", reject); });
  });
}

/** A direct child of the owning Host enters only its own reserved subgroup
 * before opening a socket or spawning vendor code. Whole-Host force includes
 * this child even while Node is starting and before that placement completes. */
export async function runDelegatedGate(directory: string): Promise<void> {
  const receipt = JSON.parse(readFileSync(join(directory, "allocation.json"), "utf8")) as {
    version: number; parent: { containment: string }; invocation: string; bootId: string;
    cgroup: string; device: string; inode: string;
  };
  const ownGroup = () => readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (receipt.version !== 2 || receipt.invocation !== process.env.INVOCATION_ID || receipt.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
    ownGroup() !== `${receipt.parent.containment}/control` || !receipt.cgroup.startsWith(`${receipt.parent.containment}/multiplex-v8-`) || receipt.cgroup.split("/").some(value => value === "." || value === "..") || sealed(directory)) throw Error("Owning Host gate is fenced");
  const group = openSync(join("/sys/fs/cgroup", receipt.cgroup.slice(1)), "r");
  try {
    const info = fstatSync(group, { bigint: true });
    if (!info.isDirectory() || String(info.dev) !== receipt.device || String(info.ino) !== receipt.inode) throw Error("Native subgroup changed");
    writeFileSync(`/proc/self/fd/${group}/cgroup.procs`, String(process.pid));
  } finally { closeSync(group); }
  if (ownGroup() !== receipt.cgroup || sealed(directory)) throw Error("Native subgroup acquisition was sealed");
  await runSystemdGate(directory);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !["--gate", "--delegated-gate"].includes(process.argv[2]!)) throw Error("Invalid internal native gate invocation");
  await (process.argv[2] === "--delegated-gate" ? runDelegatedGate : runSystemdGate)(process.argv[3]!);
}
