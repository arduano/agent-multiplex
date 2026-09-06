import {
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonObject,
  type JsonValue,
} from "@arduano/agent-multiplex-protocol";

import { PathPolicyError, type RuntimePathPolicy } from "./path-policy.js";

const hasOwn = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asObject = (value: JsonValue, description: string): JsonObject => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new NativePathPolicyError(`${description} must be a JSON object`);
  }
  return value;
};

export class NativePathPolicyError extends PathPolicyError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativePathPolicyError";
  }
}

/**
 * Applies the runtime-node-local path policy to path-bearing fields in the pinned
 * Codex and Copilot native extension surfaces. Unknown native fields remain
 * opaque by design; callers with native passthrough access are trusted.
 */
export class NativePathPolicy {
  readonly #paths: RuntimePathPolicy;

  public constructor(paths: RuntimePathPolicy) {
    this.#paths = paths;
  }

  public async spawn(options: HarnessSpawnOptions): Promise<HarnessSpawnOptions> {
    if (!options.native) return options;
    if (options.harness === "codex") {
      return { ...options, native: await this.#codexSession(options.native, "spawn") };
    }
    return { ...options, native: await this.#copilotSession(options.native) };
  }

  public async resume(options: HarnessResumeOptions): Promise<HarnessResumeOptions> {
    if (!options.native) return options;
    if (options.harness === "codex") {
      return { ...options, native: await this.#codexSession(options.native, "resume") };
    }
    return { ...options, native: await this.#copilotSession(options.native) };
  }

  public async command(request: HarnessCommand): Promise<HarnessCommand> {
    if (request.harness === "codex") {
      const command = request.command;
      if (command.type !== "send" && command.type !== "steer") return request;
      const input =
        typeof command.input === "string"
          ? command.input
          : await Promise.all(
              command.input.map((item, index) => this.#codexInput(item, index)),
            );
      const native = command.native
        ? await this.#codexTurn(command.native)
        : undefined;
      return {
        ...request,
        command: {
          ...command,
          input,
          ...(native ? { native } : {}),
        },
      };
    }

    const command = request.command;
    if (command.type !== "send" && command.type !== "steer") return request;
    const prompt =
      typeof command.prompt === "string"
        ? command.prompt
        : await this.#copilotMessage(command.prompt, "Copilot prompt");
    const native = command.native
      ? await this.#copilotMessage(command.native, "Copilot native message")
      : undefined;
    return {
      ...request,
      command: {
        ...command,
        prompt,
        ...(native ? { native } : {}),
      },
    };
  }

  async #codexSession(
    native: JsonObject,
    operation: "spawn" | "resume",
  ): Promise<JsonObject> {
    this.#rejectControlled(native, "cwd", "Codex native.cwd", "cwd");
    if (operation === "resume") {
      this.#reject(native, "path", "Codex native.path cannot select a rollout during resume");
      this.#reject(
        native,
        "history",
        "Codex native.history cannot replace the bound thread during resume",
      );
    }
    const result = { ...native };
    await this.#pathArray(result, "runtimeWorkspaceRoots", "Codex runtime workspace root");
    this.#rejectEnvironmentPaths(result, "environments", "Codex native environments");
    this.#rejectEnvironmentPaths(
      result,
      "selectedCapabilityRoots",
      "Codex native selected capability roots",
    );
    return result;
  }

  async #codexTurn(native: JsonObject): Promise<JsonObject> {
    const result = { ...native };
    await this.#path(result, "cwd", "Codex turn working directory");
    await this.#pathArray(result, "runtimeWorkspaceRoots", "Codex runtime workspace root");
    this.#rejectEnvironmentPaths(result, "environments", "Codex turn environments");

    const sandboxPolicy = result.sandboxPolicy;
    if (sandboxPolicy !== undefined && sandboxPolicy !== null) {
      const sandbox = { ...asObject(sandboxPolicy, "Codex native.sandboxPolicy") };
      await this.#pathArray(sandbox, "writableRoots", "Codex sandbox writable root");
      // Older native payloads used the generated Rust field spelling.
      await this.#pathArray(sandbox, "writable_roots", "Codex sandbox writable root");
      result.sandboxPolicy = sandbox;
    }
    return result;
  }

  async #codexInput(value: JsonValue, index: number): Promise<JsonValue> {
    if (value === null || Array.isArray(value) || typeof value !== "object") return value;
    const type = value.type;
    if (
      type !== "localImage" &&
      type !== "localAudio" &&
      type !== "skill" &&
      type !== "mention"
    ) {
      return value;
    }
    const result = { ...value };
    if (typeof result.path !== "string") {
      throw new NativePathPolicyError(`Codex input[${index}].path must be a string`);
    }
    result.path = await this.#paths.validatePath(
      result.path,
      `Codex ${type} input path`,
    );
    return result;
  }

  async #copilotSession(native: JsonObject): Promise<JsonObject> {
    this.#rejectControlled(
      native,
      "workingDirectory",
      "Copilot native.workingDirectory",
      "cwd",
    );
    this.#rejectControlled(
      native,
      "additionalDirectories",
      "Copilot native.additionalDirectories",
      "additionalDirectories",
    );
    this.#reject(
      native,
      "provider",
      "Copilot native.provider is runtime-node-local because it can contain credentials; configure the runtime-node BYOK provider instead",
    );
    this.#reject(
      native,
      "providers",
      "Copilot native.providers are runtime-node-local because they can contain credentials; configure the runtime-node BYOK provider instead",
    );
    const result = { ...native };
    await this.#path(result, "configDirectory", "Copilot config directory");
    await this.#path(result, "extensionSdkPath", "Copilot extension SDK path");
    await this.#pathArray(result, "skillDirectories", "Copilot skill directory");
    await this.#pathArray(result, "pluginDirectories", "Copilot plugin directory");
    await this.#pathArray(
      result,
      "instructionDirectories",
      "Copilot instruction directory",
    );

    const nativeLargeOutput = result.largeOutput;
    if (nativeLargeOutput !== undefined && nativeLargeOutput !== null) {
      const largeOutput = { ...asObject(nativeLargeOutput, "Copilot native.largeOutput") };
      await this.#path(largeOutput, "outputDirectory", "Copilot large-output directory");
      result.largeOutput = largeOutput;
    }
    const nativeMcpServers = result.mcpServers;
    if (nativeMcpServers !== undefined && nativeMcpServers !== null) {
      result.mcpServers = await this.#copilotMcpServers(
        nativeMcpServers,
        "Copilot native.mcpServers",
      );
    }
    const nativeCustomAgents = result.customAgents;
    if (nativeCustomAgents !== undefined && nativeCustomAgents !== null) {
      if (!Array.isArray(nativeCustomAgents)) {
        throw new NativePathPolicyError("Copilot native.customAgents must be an array");
      }
      result.customAgents = await Promise.all(
        nativeCustomAgents.map(async (agent, index) => {
          const copy = {
            ...asObject(agent, `Copilot native.customAgents[${index}]`),
          };
          const agentMcpServers = copy.mcpServers;
          if (agentMcpServers !== undefined && agentMcpServers !== null) {
            copy.mcpServers = await this.#copilotMcpServers(
              agentMcpServers,
              `Copilot native.customAgents[${index}].mcpServers`,
            );
          }
          return copy;
        }),
      );
    }
    return result;
  }

  async #copilotMcpServers(value: JsonValue, description: string): Promise<JsonObject> {
    const servers = asObject(value, description);
    const result: Array<[string, JsonValue]> = [];
    for (const [name, config] of Object.entries(servers)) {
      const copy = { ...asObject(config, `${description}.${name}`) };
      await this.#path(
        copy,
        "workingDirectory",
        `Copilot MCP server ${name} working directory`,
      );
      result.push([name, copy]);
    }
    return Object.fromEntries(result);
  }

  async #copilotMessage(message: JsonObject, description: string): Promise<JsonObject> {
    if (!hasOwn(message, "attachments") || message.attachments === null) return message;
    if (!Array.isArray(message.attachments)) {
      throw new NativePathPolicyError(`${description}.attachments must be an array`);
    }
    const attachments = await Promise.all(
      message.attachments.map(async (attachment, index) => {
        const copy = {
          ...asObject(attachment, `${description}.attachments[${index}]`),
        };
        if (copy.type === "file" || copy.type === "directory") {
          await this.#path(
            copy,
            "path",
            `${description} ${String(copy.type)} attachment path`,
          );
        } else if (copy.type === "selection") {
          await this.#path(
            copy,
            "filePath",
            `${description} selection attachment path`,
          );
        }
        return copy;
      }),
    );
    return { ...message, attachments };
  }

  async #path(target: JsonObject, key: string, description: string): Promise<void> {
    if (!hasOwn(target, key) || target[key] === null) return;
    const value = target[key];
    if (typeof value !== "string") {
      throw new NativePathPolicyError(`${description} must be a string`);
    }
    target[key] = await this.#paths.validatePath(value, description);
  }

  async #pathArray(target: JsonObject, key: string, description: string): Promise<void> {
    if (!hasOwn(target, key) || target[key] === null) return;
    const value = target[key];
    if (!Array.isArray(value)) {
      throw new NativePathPolicyError(`${description} entries must be an array`);
    }
    target[key] = await Promise.all(
      value.map(async (entry, index) => {
        if (typeof entry !== "string") {
          throw new NativePathPolicyError(`${description}[${index}] must be a string`);
        }
        return this.#paths.validatePath(entry, description);
      }),
    );
  }

  #rejectEnvironmentPaths(target: JsonObject, key: string, description: string): void {
    if (!hasOwn(target, key) || target[key] === null) return;
    const value = target[key];
    if (!Array.isArray(value)) {
      throw new NativePathPolicyError(`${description} must be an array`);
    }
    if (value.length > 0) {
      throw new NativePathPolicyError(
        `${description} are unsupported because local allowed roots cannot fence environment-native paths`,
      );
    }
  }

  #rejectControlled(
    target: JsonObject,
    key: string,
    description: string,
    typedField: string,
  ): void {
    this.#reject(
      target,
      key,
      `${description} is runtime-node-controlled; use the typed ${typedField} field`,
    );
  }

  #reject(target: JsonObject, key: string, message: string): void {
    if (hasOwn(target, key)) throw new NativePathPolicyError(message);
  }
}
