import { describe, expect, it, vi } from "vitest";

import { readRegistryDistTags } from "../scripts/npm-registry-dist-tags.mjs";

describe("npm registry dist-tag reads", () => {
  it("queries through the exact published version when bare-name lookup would be empty", () => {
    const spawn = vi.fn((_command: string, arguments_: string[]) => {
      const packageSpec = arguments_[1];
      return packageSpec === "@arduano/agent-multiplex-protocol@0.1.0"
        ? { status: 0, stdout: '{"next":"0.1.0"}\n', stderr: "" }
        : { status: 0, stdout: "", stderr: "" };
    });

    expect(readRegistryDistTags(
      "@arduano/agent-multiplex-protocol",
      "0.1.0",
      {
        registry: "https://npm.pkg.github.com",
        cwd: "/checkout",
        environment: { NODE_AUTH_TOKEN: "redacted" },
        spawn,
      },
    )).toEqual({ next: "0.1.0" });
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      [
        "view",
        "@arduano/agent-multiplex-protocol@0.1.0",
        "dist-tags",
        "--json",
        "--registry",
        "https://npm.pkg.github.com",
      ],
      {
        cwd: "/checkout",
        encoding: "utf8",
        env: { NODE_AUTH_TOKEN: "redacted" },
      },
    );
  });

  it.each([
    ["empty output", { status: 0, stdout: "", stderr: "" }, "empty dist-tags"],
    ["malformed JSON", { status: 0, stdout: "not-json", stderr: "" }, "invalid dist-tags JSON"],
    ["non-object JSON", { status: 0, stdout: "null", stderr: "" }, "invalid dist-tags"],
    ["npm failure", { status: 1, stdout: "", stderr: "registry unavailable" }, "npm view failed"],
  ])("fails closed on %s", (_label, response, expectedError) => {
    expect(() => readRegistryDistTags("@arduano/example", "0.1.0", {
      registry: "https://npm.pkg.github.com",
      cwd: "/checkout",
      environment: {},
      spawn: () => response,
    })).toThrow(expectedError);
  });
});
