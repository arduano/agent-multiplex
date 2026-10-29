import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

/** The application supplies an already-private directory. Never repair a
 * shared directory, follow a symlink or infer privacy from a pathname. */
export function privateFile(filename: string, create: boolean): void {
  if (process.platform === "win32" || !process.getuid)
    throw new Error(
      "Private SQLite requires qualified POSIX ownership; Windows ACL support is not implemented",
    );
  if (!isAbsolute(filename) || normalize(filename) !== filename)
    throw new TypeError("Database path must be absolute and normalized");
  const directory = dirname(filename);
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700
  )
    throw new Error("Database directory is not private");
  let descriptor: number;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    descriptor = openSync(
      filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const parentDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
    return;
  }
  try {
    const file = fstatSync(descriptor);
    if (
      !file.isFile() ||
      file.uid !== process.getuid() ||
      file.nlink !== 1 ||
      (file.mode & 0o777) !== 0o600
    )
      throw new Error("Database file is not private");
  } finally {
    closeSync(descriptor);
  }
}

export function existingSidecars(filename: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      privateFile(filename + suffix, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
