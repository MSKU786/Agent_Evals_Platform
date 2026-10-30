// Small display helpers shared by the pages.

/** A 0..1 fraction as a percentage, e.g. 0.8 → "80.0%". */
export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

/** A 0..1 score difference as signed percentage points, e.g. 0.12 → "+12.0 pp". */
export function pp(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const v = x * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} pp`;
}

/** A CI of 0..1 values as a percentage range. */
export function ciPct(lo: number, hi: number): string {
  return `[${pct(lo)}, ${pct(hi)}]`;
}

/** A CI of 0..1 differences as a percentage-point range. */
export function ciPp(lo: number, hi: number): string {
  return `[${pp(lo)}, ${pp(hi)}]`;
}

export function money(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `$${x.toFixed(4)}`;
}

export function ms(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${Math.round(x)} ms`;
}

export function pval(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return x < 0.001 ? "<0.001" : x.toFixed(3);
}

/** An integer with thousands separators, pinned to en-US so the rendered
 * number is deterministic regardless of the browser/host locale. */
export function int(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return x.toLocaleString("en-US");
}

/** A short local date (en-US) for table columns, deterministic across hosts. */
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
