/** The part of `Document` that `whenActivated` needs; `prerendering` is missing in browsers without prerender support. */
export interface ActivationTarget {
  readonly prerendering?: boolean;
  addEventListener(type: "prerenderingchange", listener: () => void, options?: { once: boolean }): void;
}

/**
 * Resolves when the page is actually shown: at once for a normal load, after one `prerenderingchange` for a prerendered
 * document (which runs its scripts before the visitor has navigated to it).
 */
export function whenActivated(doc: ActivationTarget): Promise<void> {
  if (!doc.prerendering) return Promise.resolve();
  return new Promise((resolve) => doc.addEventListener("prerenderingchange", () => resolve(), { once: true }));
}
