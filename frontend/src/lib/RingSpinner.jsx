// ---------------------------------------------------------------------------
// The loading indicator.
//
// A ring, not a pulsing dot. Two reasons, both from users:
//
//   * A dot that fades in and out reads as decoration, so a slow wallet-provider
//     load looked like the app had hung on a blank screen. A ring that turns is
//     unmistakably "work in progress".
//   * The indicator that shows BEFORE the first page renders is the only thing on
//     screen while Privy or Reown is still fetching. It carries no text: a user
//     asked for the ring and nothing else, and a paragraph under a spinner on a
//     first paint is noise they cannot act on yet. What is happening is still
//     available to a screen reader through aria-label, and the pages themselves
//     explain the wait once they render.
//
// Its own module with no imports beyond React: SessionLayer suspends on the
// wallet chunks, so this must not pull anything heavy into the first paint.
// ---------------------------------------------------------------------------

import React from "react";

/**
 * A circular spinner. Colour comes from `currentColor`, so the caller picks it
 * with any `text-*` token.
 *
 * The whole SVG rotates rather than just the arc: a CSS transform on an inner SVG
 * element needs a transform-box/origin pair to behave across browsers, and the
 * wrapper spin needs neither.
 */
export function RingSpinner({ size = 18, className = "" }) {
  return (
    <svg
      className={`ring-spin shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" />
      <path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Full-screen boot state: the ring, centred, and nothing else.
 *
 * `role="status"` + `aria-label` keep it honest for a screen reader without
 * putting words on the screen.
 */
export function BootScreen({ size = 34, tone = "text-btc" }) {
  return (
    <div className="grid min-h-screen place-items-center">
      <div role="status" aria-live="polite" aria-label="Loading">
        <RingSpinner size={size} className={tone} />
      </div>
    </div>
  );
}

export default RingSpinner;
