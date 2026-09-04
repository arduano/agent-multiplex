import { describe, expect, it } from "vitest";

import {
  githubCommitStatusResponseMatchesRequest,
} from "../scripts/github-commit-status.mjs";

const sourceCommit = "a1bda9276755bc1112dc3aaeed3af4c81db69ff4";
const repository = "arduano/agent-multiplex";
const request = {
  repository,
  sourceCommit,
  state: "success",
  context: "Agent Multiplex / Native four-container qualification",
  description:
    "PASS 20260904T205905Z-3f2919de7764 sha256:12f6afad76258e2b4a10141d6dacb2f3a14186b2c5b61cd4619b172330686c5e",
  targetUrl: `https://github.com/${repository}/commit/${sourceCommit}`,
  creatorId: 17287063,
};

const realisticGitHubResponse = {
  url: `https://api.github.com/repos/${repository}/statuses/${sourceCommit}`,
  avatar_url: "https://avatars.githubusercontent.com/u/17287063?v=4",
  id: 31064063094,
  node_id: "SC_kwDOPmGqyM8AAAAGS4Aydg",
  state: request.state,
  description: request.description,
  target_url: request.targetUrl,
  context: request.context,
  created_at: "2026-09-05T01:42:03Z",
  updated_at: "2026-09-05T01:42:03Z",
  creator: {
    login: "arduano",
    id: request.creatorId,
    node_id: "MDQ6VXNlcjE3Mjg3MDYz",
    avatar_url: "https://avatars.githubusercontent.com/u/17287063?v=4",
    url: "https://api.github.com/users/arduano",
    html_url: "https://github.com/arduano",
    type: "User",
    site_admin: false,
  },
};

describe("native qualification GitHub commit status response", () => {
  it("accepts GitHub's create-status response without a sha field", () => {
    expect(realisticGitHubResponse).not.toHaveProperty("sha");
    expect(
      githubCommitStatusResponseMatchesRequest(realisticGitHubResponse, request),
    ).toBe(true);
  });

  it.each([
    ["repository", {
      url: `https://api.github.com/repos/someone-else/agent-multiplex/statuses/${sourceCommit}`,
    }],
    ["commit", {
      url: `https://api.github.com/repos/${repository}/statuses/${"f".repeat(40)}`,
    }],
    ["state", { state: "pending" }],
    ["context", { context: "another check" }],
    ["description", { description: "PASS another receipt" }],
    ["target URL", { target_url: "https://example.invalid/commit" }],
    ["creator", { creator: { ...realisticGitHubResponse.creator, id: 1 } }],
  ])("rejects a response bound to a different %s", (_field, override) => {
    expect(githubCommitStatusResponseMatchesRequest(
      { ...realisticGitHubResponse, ...override },
      request,
    )).toBe(false);
  });

  it("does not accept a caller-supplied sha in place of GitHub's URL binding", () => {
    const { url: _url, ...withoutUrl } = realisticGitHubResponse;
    expect(githubCommitStatusResponseMatchesRequest(
      { ...withoutUrl, sha: sourceCommit },
      request,
    )).toBe(false);
  });
});
