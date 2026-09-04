export const styleNonceMetaName = "agent-multiplex-style-nonce";

const styleNoncePattern = /^[A-Za-z0-9_-]{16,}$/;

export function styleNonceForDocument(target: Document): string | undefined {
  const nonce = target.querySelector<HTMLMetaElement>(
    `meta[name="${styleNonceMetaName}"]`,
  )?.content;
  return nonce && styleNoncePattern.test(nonce) ? nonce : undefined;
}

/**
 * Some browser libraries create styles through the ambient document even when
 * they accept a document override. Temporarily decorate the real document's
 * createElement method so every synchronously created stylesheet receives the
 * response nonce before it can be inserted into the DOM.
 *
 * The callback is deliberately synchronous. The original document method is
 * restored before this function returns, including when the callback throws.
 */
export function withSynchronousStyleNonce<Result>(
  target: Document,
  nonce: string | undefined,
  work: () => Result,
): Result {
  if (!nonce) {
    return work();
  }

  const ownDescriptor = Object.getOwnPropertyDescriptor(target, "createElement");
  const originalCreateElement = target.createElement;
  const createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement.call(target, tagName, options);
    if (tagName.toLowerCase() === "style") element.setAttribute("nonce", nonce);
    return element;
  }) as Document["createElement"];

  Object.defineProperty(target, "createElement", {
    configurable: true,
    writable: true,
    value: createElement,
  });
  try {
    return work();
  } finally {
    if (ownDescriptor) {
      Object.defineProperty(target, "createElement", ownDescriptor);
    } else if (!Reflect.deleteProperty(target, "createElement")) {
      throw new Error("Unable to restore the browser document createElement method");
    }
  }
}
