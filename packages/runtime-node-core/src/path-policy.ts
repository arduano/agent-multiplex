import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathPolicyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathPolicyError";
  }
}

export class AllowedPathPolicy {
  readonly #configuredRoots: readonly string[];
  #resolvedRoots: readonly string[] | undefined;

  public constructor(roots: readonly string[]) {
    if (roots.length === 0) {
      throw new PathPolicyError("at least one allowed root must be configured");
    }
    this.#configuredRoots = [...roots];
  }

  public async roots(): Promise<readonly string[]> {
    if (!this.#resolvedRoots) {
      this.#resolvedRoots = await Promise.all(
        this.#configuredRoots.map(async (root) => realpath(resolve(root))),
      );
    }
    return this.#resolvedRoots;
  }

  public async validate(path: string): Promise<string> {
    return this.validatePath(path, "working directory");
  }

  /** Canonicalize any existing local path and fence it to an allowed root. */
  public async validatePath(path: string, description = "path"): Promise<string> {
    if (!isAbsolute(path)) {
      throw new PathPolicyError(`${description} must be absolute: ${path}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (cause) {
      throw new PathPolicyError(`${description} does not exist: ${path}`, { cause });
    }
    const allowed = (await this.roots()).some((root) => {
      const child = relative(root, canonical);
      return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
    });
    if (!allowed) {
      throw new PathPolicyError(
        `${description} ${canonical} is outside configured allowed roots`,
      );
    }
    return canonical;
  }
}
