// ---------------------------------------------------------------------------
// Charts — hand-rolled SVG, and deliberately so.
//
// A charting library was the obvious move and the wrong one. Recharts alone is
// ~120kB gzipped plus d3-scale/d3-shape, and it would be the largest dependency
// in the frontend for four small visuals on one page. This module adds nothing
// to the bundle, needs no network (the in-app preview is a sandboxed iframe with
// no external assets), and every path is styled with the same CSS custom
// properties as the rest of the app — so a chart recolours when a token does
// instead of carrying a hardcoded palette somebody has to remember.
//
// ALL THE ARITHMETIC LIVES IN lib/charts-data.js, NOT HERE. That split is not
// tidiness: Node cannot import .jsx, so anything in this file is untestable
// offline, and the bucketing is the part where a bug is invisible on screen.
// `npm run test:charts` covers it.
//
// Tooltips are native <title> elements inside the SVG node they describe. No JS
// hover state: a custom tooltip re-renders the chart on every mousemove, breaks
// on touch, and needs positioning maths a browser already does.
// ---------------------------------------------------------------------------

import React from "react";
import {
  bucketLabel, bucketTick, toneVar,
} from "../lib/charts-data.js";

let uid = 0;
const nextId = (p) => `${p}${(uid += 1)}`;

/** "Not enough data yet" — the only acceptable empty state for a chart. */
function NoData({ height = 140, children }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line bg-ink-dim/40 px-4 text-center"
      style={{ minHeight: height }}
    >
      <span className="text-[13.5px] font-medium text-dim">
        {children || "Not enough data yet"}
      </span>
      <span className="text-[12.5px] leading-snug text-faint">
        A chart here would be a guess, so there isn't one.
      </span>
    </div>
  );
}

// Tooltips are native <title> elements INSIDE the SVG node they describe. No JS
// hover state: a custom tooltip re-renders the chart on every mousemove, breaks
// on touch, and needs positioning maths that a browser already does.

// ---------------------------------------------------------------------------
// Sparkline — an area+line series, one value per bucket
// ---------------------------------------------------------------------------

/**
 * @param {Array}  buckets   from bucketSeries()
 * @param {string} valueKey  "amountWei" (default) | "count"
 * @param {string} tone      semantic colour
 * @param {Function} format  value -> string for the tooltip
 */
export function Sparkline({
  buckets = [], valueKey = "amountWei", tone = "btc", format = (v) => String(v),
  height = 132, span = "day", minPoints = 2,
}) {
  const gid = React.useMemo(() => nextId("spark"), []);
  const data = buckets || [];
  if (data.length < minPoints) {
    return (
      <NoData height={height}>
        {data.length === 0 ? "No payments recorded yet" : "One data point so far"}
      </NoData>
    );
  }

  const W = 100 * Math.max(data.length - 1, 1);
  const H = 100;
  const PAD_TOP = 8;
  const vals = data.map((b) => (valueKey === "count" ? b.count : Number(b.amountWei)));
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;

  const x = (i) => (i / (data.length - 1)) * W;
  const y = (v) => PAD_TOP + (1 - (v - min) / range) * (H - PAD_TOP * 2);

  const line = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(2)},${H} L${x(0).toFixed(2)},${H} Z`;
  const color = toneVar(tone);
  const peak = vals.indexOf(max);

  return (
    <div className="w-full">
      {/* preserveAspectRatio="none" stretches the plot to the container; the
          stroke uses vector-effect="non-scaling-stroke" so it stays 2px wide
          instead of stretching with it. Without that pair, a wide chart gets a
          fat horizontal line and a thin vertical one. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-label={`Sparkline of ${data.length} buckets, peak ${format(max)}`}
        className="block overflow-visible"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* baseline at zero, so a reader can see the axis the values sit on */}
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--color-line-soft)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

        <path d={area} fill={`url(#${gid})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="animate-draw"
          style={{ "--draw-len": 2400 }}
        />

        {/* One marker: the peak. Marking every point on a 30-bucket series is
            noise; marking the highest one is information. */}
        {max > 0 && (
          <circle
            cx={x(peak)} cy={y(max)} r="3.5"
            fill="var(--color-panel)" stroke={color} strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${bucketLabel(data[peak], span)} — peak ${format(max)}`}</title>
          </circle>
        )}

        {/* Invisible hit strips, one per bucket, so hovering anywhere near a
            point reports it. Cheaper and more forgiving than a 3px target. */}
        {data.map((b, i) => (
          <rect key={b.start} x={x(i) - W / (2 * (data.length - 1))} y={0} width={W / (data.length - 1)} height={H} fill="transparent">
            <title>{`${bucketLabel(b, span)}\n${b.count} payment${b.count === 1 ? "" : "s"}\n${format(valueKey === "count" ? b.count : b.amountWei)}`}</title>
          </rect>
        ))}
      </svg>

      <div className="mt-1.5 flex items-center justify-between text-[12px] text-faint">
        <span>{bucketTick(data[0], span)}</span>
        <span className="text-dim">
          peak {format(max)} · {data.length} bucket{data.length === 1 ? "" : "s"} UTC
        </span>
        <span>{bucketTick(data[data.length - 1], span)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bar chart — one bar per bucket, or per category
// ---------------------------------------------------------------------------

/**
 * @param {Array} data    [{ label, value, tone?, title? }]
 * @param {Function} format value -> string
 */
export function BarChart({ data = [], format = (v) => String(v), height = 168, tone = "info", emptyText = "Nothing to show yet" }) {
  const rows = (data || []).filter((d) => d && Number(d.value) >= 0);
  if (!rows.length) return <NoData height={height}>{emptyText}</NoData>;

  const max = Math.max(...rows.map((r) => Number(r.value)), 0);
  if (max === 0) return <NoData height={height}>{emptyText}</NoData>;

  return (
    <div className="flex w-full items-end gap-1.5" style={{ height }}>
      {rows.map((r, i) => {
        const h = Math.max(2, (Number(r.value) / max) * 100);
        const c = toneVar(r.tone || tone);
        return (
          <div key={r.label + i} className="group relative flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5" style={{ height: "100%" }}>
            {/* the value, shown above the bar; hidden on very narrow bars where
                it would overlap its neighbour, and still in the title */}
            <span className="tnum text-[11.5px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
              {format(r.value)}
            </span>
            <div
              className="w-full rounded-t-[4px] transition-all duration-300 group-hover:brightness-125 animate-grow"
              style={{
                height: `${h}%`,
                backgroundColor: c,
                // A quiet bar is still a bar: never drop below 2px or a real
                // value disappears and the chart reads as empty.
                minHeight: 2,
                "--reveal-delay": `${i * 45}ms`,
              }}
              title={r.title || `${r.label}: ${format(r.value)}`}
            />
            <span className="w-full truncate text-center text-[11.5px] text-faint" title={r.label}>
              {r.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut — parts of a whole, with the total in the middle
// ---------------------------------------------------------------------------

/**
 * @param {Array} slices [{ label, value, tone }]
 * @param {string} centre      the big number in the middle
 * @param {string} centreLabel the caption under it
 *
 * Drawn with stroke-dasharray on circles rather than arc paths: no trig, no
 * large-arc-flag edge case at 180°, and each segment is a separate element so it
 * can carry its own <title>.
 */
export function Donut({ slices = [], centre, centreLabel, size = 168, thickness = 16, emptyText = "Nothing to break down yet" }) {
  const rows = (slices || []).filter((s) => s && Number(s.value) > 0);
  const total = rows.reduce((n, s) => n + Number(s.value), 0);
  if (!rows.length || total === 0) return <NoData height={size}>{emptyText}</NoData>;

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={`${centreLabel || "total"}: ${centre ?? total}`} className="shrink-0">
        {/* the track, so a single-slice donut still reads as a ring */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-soft)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {rows.map((s, i) => {
            const frac = Number(s.value) / total;
            const dash = frac * c;
            // A 0.6px gap between segments keeps adjacent same-colour slices
            // distinguishable without eating a visible amount of the ring.
            const gap = rows.length > 1 ? 0.6 : 0;
            const el = (
              <circle
                key={s.label + i}
                cx={size / 2} cy={size / 2} r={r}
                fill="none"
                stroke={toneVar(s.tone)}
                strokeWidth={thickness}
                strokeLinecap="butt"
                strokeDasharray={`${Math.max(dash - gap, 0.1)} ${c - Math.max(dash - gap, 0.1)}`}
                strokeDashoffset={-acc}
                className="transition-[stroke-dasharray,stroke-dashoffset] duration-500"
              >
                <title>{`${s.label}: ${s.value} (${(frac * 100).toFixed(1)}%)`}</title>
              </circle>
            );
            acc += dash;
            return el;
          })}
        </g>
        {centre !== undefined && (
          <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle"
                className="tnum" fill="var(--color-text)"
                style={{ fontSize: size / 7.4, fontWeight: 600 }}>
            {centre}
          </text>
        )}
        {centreLabel && (
          <text x="50%" y="63%" textAnchor="middle" dominantBaseline="middle"
                fill="var(--color-dim)" style={{ fontSize: size / 14.5 }}>
            {centreLabel}
          </text>
        )}
      </svg>

      <ul className="min-w-[9rem] flex-1 space-y-2">
        {rows.map((s, i) => (
          <li key={s.label + i} className="flex items-center gap-2.5 text-[13.5px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: toneVar(s.tone) }} />
            <span className="min-w-0 flex-1 truncate text-muted" title={s.label}>{s.label}</span>
            <span className="tnum shrink-0 font-medium text-text">{s.value}</span>
            <span className="tnum w-[3.2rem] shrink-0 text-right text-[12.5px] text-dim">
              {((Number(s.value) / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars — the right shape for ranked labels (addresses, endpoints),
// where a vertical bar chart would need rotated text to stay readable.
// ---------------------------------------------------------------------------

export function RankBars({ rows = [], format = (v) => String(v), tone = "info", emptyText = "Nothing to rank yet", maxRows = 6 }) {
  const list = (rows || []).slice(0, maxRows);
  if (!list.length) return <NoData height={120}>{emptyText}</NoData>;
  const max = Math.max(...list.map((r) => Number(r.value)), 0);
  if (!max) return <NoData height={120}>{emptyText}</NoData>;

  return (
    <ul className="space-y-2.5">
      {list.map((r, i) => (
        <li key={r.key + i} className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3">
          <span className="truncate font-mono text-[12.5px] text-muted" title={r.key}>{r.label || r.key}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-line-soft">
            <span
              className="block h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.max((Number(r.value) / max) * 100, 1.5)}%`,
                backgroundColor: toneVar(r.tone || tone),
              }}
              title={r.title || `${r.key}: ${format(r.value)}`}
            />
          </span>
          <span className="tnum text-[13px] font-medium text-text">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export { NoData as ChartEmpty };
