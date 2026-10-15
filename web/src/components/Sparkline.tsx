// Tiny 30-day trend line (daily minimum price). Decorative: the numbers are in the card text.
export function Sparkline({ values, width = 72, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (width - 2 * pad),
    pad + (1 - (v - min) / span) * (height - 2 * pad),
  ]);
  const first = values[0], last = values[values.length - 1];
  const trend = last < first * 0.98 ? "down" : last > first * 1.02 ? "up" : "flat";
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg class={`spark spark-${trend}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke-width="1.5"
        stroke-linejoin="round" stroke-linecap="round" />
      <circle cx={lx} cy={ly} r="2.5" />
    </svg>
  );
}
