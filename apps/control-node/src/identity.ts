import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadOrCreateControlNodeSecretKey(
  filename: string,
): Promise<Uint8Array> {
  try {
    const encoded = (await readFile(filename, "utf8")).trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) {
      throw new Error(
        `${filename} must contain one base64url-encoded 32-byte Iroh key`,
      );
    }
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${Buffer.from(key).toString("base64url")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, filename);
    await chmod(filename, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const encoded = (await readFile(filename, "utf8")).trim();
    const winner = Buffer.from(encoded, "base64url");
    if (winner.byteLength !== 32) {
      throw new Error(`${filename} contains an invalid Iroh key`);
    }
    await chmod(filename, 0o600);
    return winner;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

