// ---------------------------------------------------------------------------
// Scroll reveal.
//
// A single IntersectionObserver for the whole app, installed once by the shell.
// It watches for `.reveal` elements and adds `.reveal-in` the first time each
// one enters the viewport.
//
// Why an observer over the whole document rather than a per-element hook:
// routes swap content in and out, so a hook that ran on mount would miss
// elements created later. A MutationObserver re-scans instead, and each element
// is unobserved once revealed so the work does not accumulate.
//
// PROGRESSIVE ENHANCEMENT — this matters. index.css only hides `.reveal`
// elements when <html> carries the `js-reveal` class, which is added HERE. If
// this module never runs (JS disabled, a crawler, IntersectionObserver missing)
// the page stays fully visible instead of blank. `prefers-reduced-motion`
// collapses every animation to its end state for the same reason.
// ---------------------------------------------------------------------------

import React, { useEffect } from "react";

export function useRevealObserver() {
  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return undefined;

    const root = document.documentElement;
    root.classList.add("js-reveal");

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal-in");
            io.unobserve(entry.target);
          }
        }
      },
      // Trigger slightly before the element is fully on screen so motion feels
      // like it belongs to the scroll rather than lagging behind it.
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
    );

    const scan = () => {
      document.querySelectorAll(".reveal:not(.reveal-in)").forEach((el) => io.observe(el));
    };
    scan();

    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      root.classList.remove("js-reveal");
    };
  }, []);
}

/**
 * Wrapper that fades its child up on scroll. `delay` staggers siblings, which is
 * what makes a row of cards read as one motion instead of a flicker.
 */
export function Reveal({ as: Tag = "div", delay = 0, className = "", children, ...rest }) {
  return (
    <Tag
      className={`reveal ${className}`}
      style={{ "--reveal-delay": `${delay}ms`, ...(rest.style || {}) }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * Scrolls to `location.hash` after a route change.
 *
 * Needed because the navbar's "How it works" points at /#how-it-works. When the
 * user is already on the landing page, changing only the hash does not remount
 * anything, so nothing would scroll without this.
 */
export function useHashScroll(deps = []) {
  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (!hash) {
      window.scrollTo({ top: 0, behavior: "auto" });
      return undefined;
    }
    const id = hash.slice(1);
    // One frame, so the target exists in the DOM before we measure it.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
