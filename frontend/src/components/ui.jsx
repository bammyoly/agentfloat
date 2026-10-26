// ---------------------------------------------------------------------------
// Shared UI primitives.
//
// Small on purpose: the whole app is built from Card / Stat / Badge / Button so
// the design stays consistent and minimalist, and so a page reads as content
// rather than markup. Tailwind classes come from the @layer components
// definitions in index.css — read the TYPE SCALE comment there before adding an
// arbitrary text-[Npx] here.
//
// ICONS are lucide-react (https://lucide.dev), used through the helpers at the
// top of this file so that:
//   • size and stroke width are consistent everywhere (16px / 1.75 by default),
//   • an icon never shrinks or wraps inside a flex row (`shrink-0`),
//   • an icon is `aria-hidden` unless a caller says it carries the label,
//   • colour is inherited, so `text-ok` on the parent tints the icon too.
// Never scatter raw <SomeIcon size={13} /> calls through pages: that is how an
// interface ends up with eleven slightly different icon sizes.
// ---------------------------------------------------------------------------

import React from "react";
import { Link } from "react-router-dom";
import {
  Check, ChevronRight, CircleSlash, Copy, ExternalLink, Inbox,
} from "lucide-react";
import { explorerTx, explorerAddress } from "../contracts/index.js";
import { short } from "../lib/chain.js";
import { RingSpinner } from "../lib/RingSpinner.jsx";

// ---------------------------------------------------------------------------
// Icon plumbing
// ---------------------------------------------------------------------------

/**
 * Render a lucide icon at the app's standard size.
 *
 * `Icon` may be null/undefined, in which case nothing renders — so callers can
 * pass an icon conditionally without a branch of their own.
 */
export function Icon({ as: C, size = 16, className = "", label = null, ...rest }) {
  if (!C) return null;
  return (
    <C
      size={size}
      strokeWidth={1.75}
      aria-hidden={label ? undefined : true}
      aria-label={label || undefined}
      role={label ? "img" : undefined}
      className={`shrink-0 ${className}`.trim()}
      {...rest}
    />
  );
}

/**
 * An icon in a tinted rounded square — the visual anchor for a card heading.
 *
 * Colour comes from the same semantic tokens the badges use, so a card about
 * something broken is red in the corner before you read a word of it. Tint is
 * done with colour-mix() rather than eight hand-picked rgba values: it stays in
 * step if a token is ever retuned.
 */
const TONE_VAR = {
  neutral: "--color-muted",
  ok: "--color-ok",
  bad: "--color-bad",
  warn: "--color-warn",
  info: "--color-info",
  btc: "--color-btc",
  accent: "--color-accent",
};

export function toneVar(tone = "neutral") {
  return `var(${TONE_VAR[tone] || TONE_VAR.neutral})`;
}

export function IconTile({ as: C, tone = "neutral", size = 18, className = "" }) {
  if (!C) return null;
  const v = toneVar(tone);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-[10px] border ${className}`}
      style={{
        width: size + 18,
        height: size + 18,
        color: v,
        borderColor: `color-mix(in srgb, ${v} 28%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${v} 12%, transparent)`,
      }}
    >
      <C size={size} strokeWidth={1.75} />
    </span>
  );
}

/**
 * Copy text to the clipboard, tolerantly.
 *
 * `navigator.clipboard` only exists in a SECURE CONTEXT. On http://localhost it
 * does; on http://192.168.1.195:5173 (how this app is reached from a phone on
 * the same LAN) it is `undefined`, so a naive copy fails silently and the user
 * gets a "copied ✓" that is a lie. Hence the hidden-textarea fallback, and a
 * boolean return so callers can say "copy blocked" instead of pretending.
 */
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * "copied ✓" feedback with automatic reset. Shared by AddressLink and the
 * navbar's user menu so both behave identically.
 */
export function useCopied(resetMs = 1600) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const mark = React.useCallback(async (text) => {
    const ok = await copyText(text);
    if (!ok) return false;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), resetMs);
    return true;
  }, [resetMs]);
  return [copied, mark];
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * A bordered panel. `title`/`aside` render a header row when given.
 *
 * `icon` puts an IconTile at the left of the heading, and `tone` colours it.
 * `sub` is one line of secondary text under the title — the place for "what
 * this panel is for", which otherwise ends up as a first paragraph competing
 * with the content.
 */
export function Card({ title, sub, icon, tone = "neutral", aside, children, className = "", pad = true, headerClassName = "" }) {
  const hasHeader = Boolean(title || aside || icon);
  return (
    <section className={`card ${className}`}>
      {hasHeader && (
        <header
          className={`flex items-center justify-between gap-3 border-b border-line px-5 py-4 ${headerClassName}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <IconTile as={icon} tone={tone} />
            <div className="min-w-0">
              <h2 className="text-[15px] leading-snug font-semibold tracking-tight text-text">
                {title}
              </h2>
              {sub && (
                <p className="mt-0.5 text-[13px] leading-snug text-dim">{sub}</p>
              )}
            </div>
          </div>
          {aside && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{aside}</div>}
        </header>
      )}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

/**
 * A labelled group of panels with consistent spacing.
 *
 * Exists because "three cards in a row" was written out longhand on six pages,
 * and each one drifted: different gaps, different breakpoints, one of them
 * forgetting `items-start` so the cards stretched to equal height and the
 * content floated.
 */
export function Grid({ cols = 2, className = "", children, itemsStart = true }) {
  const span = {
    1: "sm:grid-cols-1",
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  }[cols] || "sm:grid-cols-2";
  return (
    <div className={`grid gap-4 ${span} ${itemsStart ? "items-start" : ""} ${className}`.trim()}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const TONES = {
  ok: "badge-ok",
  bad: "badge-bad",
  warn: "badge-warn",
  info: "badge-info",
  btc: "badge-btc",
  neutral: "badge-neutral",
};

export function Badge({ tone = "neutral", children, title, icon }) {
  return (
    <span className={`badge ${TONES[tone] || TONES.neutral}`} title={title}>
      {icon ? <Icon as={icon} size={12.5} /> : null}
      {children}
    </span>
  );
}

/** A small status LED. `pulse` draws the eye to something that is wrong. */
export function Dot({ tone = "ok", pulse = false }) {
  const color =
    tone === "ok" ? "bg-ok"
    : tone === "bad" ? "bg-bad"
    : tone === "warn" ? "bg-warn"
    : tone === "btc" ? "bg-btc"
    : tone === "info" ? "bg-info"
    : "bg-faint";
  return <span className={`inline-block h-2 w-2 rounded-full ${color} ${pulse ? "pulse-dot" : ""}`} />;
}

/**
 * One number, labelled.
 *
 * `icon` sits beside the label rather than above the value: the value is what
 * the eye should land on, and a large glyph over it competes. `tone` colours the
 * value — used for a refusal count in red and a balance in the default text
 * colour, never decoratively.
 */
export function Stat({ label, value, unit, hint, icon, tone = null, className = "" }) {
  const valueColor = tone && tone !== "neutral" ? `var(${TONE_VAR[tone]})` : undefined;
  return (
    <div className={className}>
      <div className="stat-label flex items-center gap-1.5">
        {icon ? <Icon as={icon} size={12.5} className="opacity-80" /> : null}
        {label}
      </div>
      <div className="stat-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
        {unit && <span className="ml-1.5 text-[15px] font-medium text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 text-[12.5px] leading-snug text-dim">{hint}</div>}
    </div>
  );
}

/**
 * A horizontal meter, 0–100.
 *
 * Colour is derived from the value unless `tone` overrides it: green below 80%,
 * amber from 80%, red at 100%. That is a convention worth keeping — a budget
 * bar that is green while it is nearly exhausted is worse than no bar.
 * `live` adds the sheen, for a number that is moving while you watch.
 */
export function Meter({ pct, tone = null, live = false, label = "share of budget used", height = 8 }) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  const auto = w >= 100 ? "bad" : w >= 80 ? "warn" : "ok";
  const color = toneVar(tone || auto);
  return (
    <div
      className="relative w-full overflow-hidden rounded-full bg-line-soft"
      style={{ height }}
      role="meter"
      aria-valuenow={Math.round(w)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="relative h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${w}%`, backgroundColor: color }}
      >
        {live && w > 2 && <div className="animate-shimmer absolute inset-0" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({ variant = "", size = "", className = "", children, icon, iconRight, busy = false, ...rest }) {
  const v = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : variant === "ghost" ? "btn-ghost" : "";
  const s = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "";
  // className is destructured OUT of rest on purpose. Spread after the base
  // classes it would replace them wholesale — a caller passing `w-full` would
  // silently lose `btn btn-primary` and get an unstyled <button>.
  const disabled = rest.disabled || busy;
  return (
    <button className={`btn ${v} ${s} ${className}`.trim()} {...rest} disabled={disabled}>
      {busy ? <Spinner size={14} /> : icon ? <Icon as={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
      {iconRight && !busy ? <Icon as={iconRight} size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
}

/** A square icon-only button. `label` is required — it becomes the aria-label. */
export function IconButton({ as: C, label, size = 16, className = "", variant = "", ...rest }) {
  const v = variant === "danger" ? "btn-danger" : variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`btn ${v} !px-0 ${className}`.trim()}
      style={{ width: size + 20, height: size + 20 }}
      {...rest}
    >
      <Icon as={C} size={size} />
    </button>
  );
}

/**
 * A segmented control: the app's answer to "pick one of two or three".
 *
 * Replaces the earlier pattern of two adjacent `.btn` elements with
 * `aria-pressed`, which looked like two buttons and read like two actions. This
 * is one control with mutually exclusive options, and it says so:
 * role="radiogroup" + role="radio" + arrow-key movement, which is what a screen
 * reader and a keyboard both expect from a choice like this.
 *
 * options: [{ value, label, icon?, hint?, badge?, disabled?, title? }]
 * `badge` renders a small pill inside the option — used for "recommended".
 */
export function Segmented({ value, onChange, options, label, className = "", size = "" }) {
  const list = React.useRef(null);

  // Arrow keys move AND select, which is the radiogroup contract. Home/End jump.
  // Without this the control is mouse-only, and `tabIndex` below is what keeps it
  // to one tab stop instead of N.
  const onKeyDown = (e) => {
    const enabled = options.filter((o) => !o.disabled);
    const at = enabled.findIndex((o) => o.value === value);
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = enabled[(at + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    const i = list.current?.querySelectorAll("[role=radio]");
    i?.[options.indexOf(next)]?.focus();
  };

  return (
    <div className={className}>
      {label && <span className="label">{label}</span>}
      <div
        ref={list}
        role="radiogroup"
        aria-label={label || "choose one"}
        onKeyDown={onKeyDown}
        className="inline-flex w-full flex-wrap gap-1 rounded-xl border border-line bg-ink-dim p-1"
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={o.disabled}
              title={o.title || o.hint || undefined}
              onClick={() => !o.disabled && onChange(o.value)}
              className={`flex min-w-[9rem] cursor-pointer flex-1 flex-col items-start gap-0.5 rounded-lg border px-3.5 py-2.5 text-left transition-all
                disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "border-btc/50 bg-btc/12 text-text shadow-[0_4px_16px_-10px_rgba(247,147,26,0.9)]"
                    : "border-transparent text-muted hover:border-line hover:bg-panel-2 hover:text-text"
                }`}
            >
              <span className={`flex w-full items-center gap-2 text-[14px] font-medium ${active ? "text-btc" : ""}`}>
                {o.icon ? <Icon as={o.icon} size={15} /> : null}
                <span className="min-w-0 flex-1">{o.label}</span>
                {o.badge && (
                  <span
                    className="shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-semibold tracking-wide uppercase"
                    style={{
                      // currentColor, not a token: the pill inherits whichever
                      // colour the option is in, so it stays legible when the
                      // option is active (btc) and when it is not (muted).
                      borderColor: "color-mix(in srgb, currentColor 30%, transparent)",
                      backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
                    }}
                  >
                    {o.badge}
                  </span>
                )}
              </span>
              {o.hint && (
                <span className="text-[12.5px] leading-snug text-dim">{o.hint}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, required = false }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="ml-1 text-bad" aria-hidden="true">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[12.5px] leading-snug text-dim">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const NOTE_ICON = { ok: Check, bad: CircleSlash, warn: null, "": null };

export function Note({ tone = "", children, className = "", icon, title }) {
  const t = tone === "ok" ? "note-ok" : tone === "bad" ? "note-bad" : tone === "warn" ? "note-warn" : "";
  const C = icon !== undefined ? icon : NOTE_ICON[tone];
  return (
    <div className={`note ${t} ${className}`}>
      {title && (
        <div className="mb-1.5 flex items-center gap-2 text-[14px] font-semibold text-text">
          {C ? <Icon as={C} size={15} /> : null}
          {title}
        </div>
      )}
      <div className={title ? "pl-[23px]" : "flex gap-2.5"}>
        {!title && C ? <Icon as={C} size={15} className="mt-1" /> : null}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Inline progress: the ring on its own.
 *
 * No label — buttons that are busy already say what they are doing in their own
 * text ("sending…", "settling…"), and a second string next to a spinner is noise.
 */
export function Spinner({ size = 14, tone = "text-info" }) {
  return (
    <span role="status" aria-label="Working" className="inline-flex items-center">
      <RingSpinner size={size} className={tone} />
    </span>
  );
}

/** Nothing here yet. `icon` defaults to an empty tray; `action` is a slot for
 *  the one thing that would change it, because an empty state that does not say
 *  how to fill itself is a dead end. */
export function Empty({ children, icon = Inbox, action = null, className = "" }) {
  return (
    <div className={`flex flex-col items-center gap-3 px-6 py-12 text-center ${className}`}>
      <span className="grid h-12 w-12 place-items-center rounded-full border border-line bg-ink-dim text-faint">
        <Icon as={icon} size={20} />
      </span>
      <div className="max-w-md text-[14px] leading-relaxed text-dim">{children}</div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Address that COPIES on click and says so.
 *
 * It used to be one <a target="_blank"> that copied as a side effect: the click
 * opened an explorer tab, so the copy was invisible and the tab was unwanted —
 * nobody can tell whether the address reached their clipboard. Splitting the
 * two affordances makes each one legible: the address copies and flips to a
 * tick, the external-link icon next to it opens the explorer.
 */
export function AddressLink({ address, chars = 4, label, explore = true, size = 13 }) {
  const [copied, mark] = useCopied();
  if (!address) return <span className="text-dim">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 align-baseline">
      <button
        type="button"
        onClick={() => mark(address)}
        title={copied ? "Copied to clipboard" : `Copy ${address}`}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent p-0 font-mono underline underline-offset-4 transition-colors ${
          copied ? "text-ok decoration-ok/50" : "text-info decoration-line hover:decoration-info"
        }`}
        style={{ fontSize: size }}
      >
        {copied ? <Icon as={Check} size={size - 2} /> : <Icon as={Copy} size={size - 2} className="opacity-60" />}
        {copied ? "copied" : label || short(address, chars)}
      </button>
      {explore && (
        <a
          href={explorerAddress(address)}
          target="_blank"
          rel="noreferrer"
          title="Open in the Mezo explorer"
          aria-label="Open this address in the Mezo explorer"
          className="inline-flex text-dim transition-colors hover:text-info"
        >
          <Icon as={ExternalLink} size={size - 2} />
        </a>
      )}
    </span>
  );
}

export function TxLink({ hash, chars = 5, label, size = 13 }) {
  if (!hash) return <span className="text-dim">—</span>;
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      title={`Open ${hash} in the Mezo explorer`}
      className="inline-flex items-center gap-1 font-mono text-info underline decoration-line underline-offset-4 transition-colors hover:decoration-info"
      style={{ fontSize: size }}
    >
      {label || short(hash, chars)}
      <Icon as={ExternalLink} size={size - 3} className="opacity-70" />
    </a>
  );
}

/** "See the ledger" — a link styled as a row with a chevron, for the end of a
 *  panel. Distinguished from a Button because it navigates rather than acts. */
export function MoreLink({ to, children, onClick }) {
  const inner = (
    <>
      {children}
      <Icon as={ChevronRight} size={15} />
    </>
  );
  const cls = "inline-flex cursor-pointer items-center gap-1 text-[13.5px] font-medium text-info underline-offset-4 transition-colors hover:underline";
  // <Link>, not <a href>: a real navigation inside an SPA remounts the router,
  // which throws away the app-data poller and re-boots the wallet provider.
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
  return <Link to={to} className={cls}>{inner}</Link>;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export function Table({ head, children, className = "" }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={i} className={`th ${h.align === "right" ? "text-right" : ""}`}>{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Section heading used on pages, with an optional right-hand slot.
 *
 * `icon` is the page's own identity — one glyph, repeated in the navbar's
 * active link, is what makes a 9-page app navigable at a glance.
 */
export function PageHeader({ eyebrow, title, sub, aside, icon }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 text-[12px] font-semibold tracking-[0.14em] text-btc uppercase">
            {eyebrow}
          </div>
        )}
        <h1 className="flex items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight text-text">
          {icon ? <Icon as={icon} size={24} className="text-btc" /> : null}
          {title}
        </h1>
        {sub && <p className="mt-2.5 max-w-3xl text-[15px] leading-relaxed text-muted">{sub}</p>}
      </div>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
    </div>
  );
}

/**
 * The divider between "yours" and "shared" that the Dashboard and Operate pages
 * both need. A rule with a pill in the middle, so the boundary is labelled
 * rather than implied — an unlabeled divider is how a user reads the operator's
 * demo agent as their own balance.
 */
export function SectionDivider({ children }) {
  return (
    <div className="relative flex items-center py-1" role="separator">
      <div className="h-px flex-grow bg-line-soft" />
      <span className="mx-4 flex-shrink-0 rounded-full border border-line bg-ink-soft px-3.5 py-1.5 text-[11.5px] font-semibold tracking-[0.1em] text-dim uppercase">
        {children}
      </span>
      <div className="h-px flex-grow bg-line-soft" />
    </div>
  );
}
