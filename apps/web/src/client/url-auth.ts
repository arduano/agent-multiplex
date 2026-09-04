const TOKEN_FRAGMENT_KEY = "token";

/**
 * Read the prototype gateway credential from the client-only URL fragment.
 * Fragments are not included in HTTP requests or Referer headers.
 */
export function accessTokenFromHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "";
  }
  const values = new URLSearchParams(fragmentValue(url)).getAll(TOKEN_FRAGMENT_KEY);
  // Ambiguous credential sources fail closed instead of depending on parser order.
  return values.length === 1 ? values[0]!.trim() : "";
}

/** Preserve unrelated fragment parameters while making the current URL bookmarkable. */
export function hrefWithAccessToken(href: string, token: string): string {
  const url = new URL(href);
  const parameters = new URLSearchParams(fragmentValue(url));
  const value = token.trim();
  if (value) parameters.set(TOKEN_FRAGMENT_KEY, value);
  else parameters.delete(TOKEN_FRAGMENT_KEY);
  const fragment = parameters.toString();
  url.hash = fragment ? `#${fragment}` : "";
  return url.toString();
}

export function currentUrlAccessToken(): string {
  return typeof window === "undefined" ? "" : accessTokenFromHref(window.location.href);
}

export function replaceCurrentUrlAccessToken(token: string): void {
  if (typeof window === "undefined") return;
  const next = hrefWithAccessToken(window.location.href, token);
  try {
    // Bookmark persistence is a prototype convenience, not a prerequisite for
    // authentication. Some embedded or locked-down browsers reject History API
    // writes even though the client can still connect with the supplied token.
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // Keep the token in React state and let the normal authenticated connection
    // proceed; the address bar simply remains unchanged in this environment.
  }
}

function fragmentValue(url: URL): string {
  return url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
}
