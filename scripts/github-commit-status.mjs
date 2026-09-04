/**
 * GitHub's create-commit-status response does not include a `sha` field. The
 * response URL is the API's binding to the repository and commit, so require
 * that exact URL alongside every requested status field and the authenticated
 * creator identity.
 */
export function githubCommitStatusResponseMatchesRequest(
  status,
  {
    repository,
    sourceCommit,
    state,
    context,
    description,
    targetUrl,
    creatorId,
  },
) {
  if (status === null || typeof status !== "object") return false;

  return status.url ===
      `https://api.github.com/repos/${repository}/statuses/${sourceCommit}` &&
    status.state === state &&
    status.context === context &&
    status.description === description &&
    status.target_url === targetUrl &&
    status.creator?.id === creatorId;
}
