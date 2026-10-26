// ---------------------------------------------------------------------------
// privy-dom — what the DOM can tell us about the wallet provider, and whether
// the page itself is structurally broken.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE /diagnose
//   `exited_auth_flow` means two different things — "the person closed the popup"
//   and "the provider was torn down mid-handshake" — and Privy does not
//   distinguish them. The only way to tell them apart is to look at the DOM at the
//   moment of failure: how many times the provider mounted, whether it unmounted,
//   and how many Privy iframes exist.
//
//   /diagnose already made exactly those measurements. So the probe lives here and
//   both callers use it: the page renders it for a human, and PrivyLayer consults
//   it to decide whether a dismissal is a dismissal. One implementation, because
//   two would eventually disagree — and a disagreement here means either false
//   alarms on every cancel, or a real double-mount going unreported.
//
// The counters are maintained by the Bridge component in PrivyLayer.jsx on
// `window`, which is what makes "mounted twice" observable at all: React does not
// tell you, and by the time the failure surfaces the first instance is gone.
//
// Safe to import in Node: every DOM read happens inside a function, never at
// module scope, so test-auth-errors.mjs can import this without a browser.
// ---------------------------------------------------------------------------

/** Does this element look like something Privy put in the page? */
export const isPrivyish = (el) => {
  const hay =
    `${el.id || ""} ${el.name || ""} ${el.className || ""} ${el.src || ""} ` +
    `${el.getAttribute?.("data-privy-id") || ""}`;
  return /privy/i.test(hay);
};

/** Everything the DOM can tell us, re-read on demand. */
export function scanDom() {
  if (typeof document === "undefined") return null;
  const iframes = [...document.querySelectorAll("iframe")];
  const dialogs = [...document.querySelectorAll("dialog")];
  // React stamps a __reactContainer$… key on each element passed to createRoot().
  // More than one means more than one React tree, hence more than one provider.
  const roots = [...document.querySelectorAll("body *")].filter((el) =>
    Object.keys(el).some((k) => k.startsWith("__reactContainer$"))
  );
  return {
    iframes: iframes.length,
    privyIframes: iframes.filter(isPrivyish).length,
    privyIframeSrcs: iframes.filter(isPrivyish).map((f) => f.src || "(no src)").slice(0, 4),
    dialogs: dialogs.length,
    privyDialogs: dialogs.filter(isPrivyish).length,
    reactRoots: roots.length,
    reactRootIds: roots.map((r) => r.id || r.tagName.toLowerCase()).slice(0, 4),
    bridgeMounts: (typeof window !== "undefined" && window.__agentfloatBridgeMounts) || 0,
    bridgeUnmounts: (typeof window !== "undefined" && window.__agentfloatBridgeUnmounts) || 0,
  };
}

/**
 * Is the page structurally unable to complete a Privy handshake?
 *
 * @returns {{ fault: boolean, reasons: string[], dom: object|null }}
 *
 * `reasons` is returned as well as the verdict because the caller has to explain
 * itself: a toast that says "the page mounted its wallet provider twice" is
 * actionable, and one that says "sign-in failed" is not.
 *
 * CONSERVATIVE BY DESIGN. Returns `fault: false` when the DOM cannot be read at
 * all (no `document`, i.e. Node or a very early failure), because the alternative
 * is to report a structural bug on every server-rendered or test invocation. The
 * cost of being wrong in that direction is a friendly "please try again" instead
 * of a precise diagnosis — the cheap failure.
 */
export function privyStructuralFault(preScanned) {
  // `preScanned` exists for /diagnose, which already holds a dom snapshot in state
  // and re-reads it on a 700ms interval. Letting it pass that snapshot in means the
  // verdict on screen is computed from the very numbers printed next to it. Scanning
  // again would read a slightly later DOM, and a finding that says "the provider is
  // broken" beside a table showing 1 mount and 0 unmounts is worse than no finding.
  // PrivyLayer passes nothing: it wants the DOM as it is at the moment of failure.
  const dom = preScanned || scanDom();
  if (!dom) return { fault: false, reasons: [], dom: null };

  const reasons = [];
  if (dom.bridgeMounts > 1) {
    reasons.push(`the wallet provider mounted ${dom.bridgeMounts}× (healthy is exactly 1)`);
  }
  if (dom.bridgeUnmounts > 0) {
    reasons.push(`the wallet provider unmounted ${dom.bridgeUnmounts}× mid-session (healthy is 0)`);
  }
  if (dom.privyIframes > 1) {
    reasons.push(`${dom.privyIframes} sign-in iframes exist at once (healthy is 1)`);
  }
  if (dom.reactRoots > 1) {
    reasons.push(`${dom.reactRoots} React roots are mounted (${dom.reactRootIds.join(", ")})`);
  }

  return { fault: reasons.length > 0, reasons, dom };
}
