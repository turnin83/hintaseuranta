// Step-line price history: one series per (link, seller), shared crosshair + live legend readout.
import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { eur } from "../lib/format.ts";

export type ChartSeries = { key: string; label: string; colorVar: string };
export type ChartPoint = { key: string; ts: string; price_cents: number };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function PriceChart(props: { series: ChartSeries[]; points: ChartPoint[]; targetCents: number | null }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || props.points.length === 0) return;

    // Align all series on one x axis (seconds); missing values = null, gaps bridged as steps.
    const xs = [...new Set(props.points.map((p) => Math.floor(Date.parse(p.ts) / 1000)))].sort((a, b) => a - b);
    const xIndex = new Map(xs.map((x, i) => [x, i]));
    const ys = props.series.map(() => new Array<number | null>(xs.length).fill(null));
    const sIndex = new Map(props.series.map((s, i) => [s.key, i]));
    for (const p of props.points) {
      const si = sIndex.get(p.key);
      if (si == null) continue;
      ys[si][xIndex.get(Math.floor(Date.parse(p.ts) / 1000))!] = p.price_cents / 100;
    }

    const target = props.targetCents != null ? props.targetCents / 100 : null;
    const grid = { stroke: css("--line"), width: 1 };
    const axisFont = `13px ${css("--font-body") || "sans-serif"}`;
    const stepped = uPlot.paths.stepped!({ align: 1 });

    const build = () =>
      new uPlot(
        {
          width: el.clientWidth,
          height: 240,
          cursor: { points: { size: 8 }, drag: { x: false, y: false } },
          legend: { live: true },
          scales: {
            x: { time: true },
            y: {
              range: (_u, min, max) => {
                const lo = Math.min(min, target ?? min), hi = Math.max(max, target ?? max);
                const pad = Math.max((hi - lo) * 0.12, hi * 0.02);
                return [Math.max(0, lo - pad), hi + pad];
              },
            },
          },
          axes: [
            {
              stroke: css("--text-3"), grid: { show: false }, ticks: { show: false }, font: axisFont,
              values: (_u, vals) => vals.map((v) => new Date(v * 1000).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" })),
            },
            {
              stroke: css("--text-3"), grid, ticks: { show: false }, font: axisFont, size: 64,
              values: (_u, vals) => vals.map((v) => eur(Math.round(v * 100)).replace(",00", "")),
            },
          ],
          series: [
            { label: "Aika", value: (_u, v) => (v == null ? "" : new Date(v * 1000).toLocaleString("fi-FI", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })) },
            ...props.series.map((s) => ({
              label: s.label,
              stroke: css(s.colorVar),
              width: 2,
              paths: stepped,
              spanGaps: true,
              points: { show: false },
              // Step semantics: between observations the price is the last observed one.
              value: (u: uPlot, v: number | null, si: number, idx: number | null) => {
                if (v == null && idx != null) {
                  const col = u.data[si];
                  for (let k = idx; k >= 0 && v == null; k--) v = col[k] ?? null;
                }
                return v == null ? "–" : eur(Math.round(v * 100));
              },
            })),
          ],
          hooks: {
            // Without a hovered point the legend shows the latest prices.
            ready: [(u) => u.setLegend({ idx: xs.length - 1 })],
            setCursor: [(u) => {
              if (u.cursor.idx == null) u.setLegend({ idx: xs.length - 1 });
            }],
            draw: [
              (u) => {
                if (target == null) return;
                const y = Math.round(u.valToPos(target, "y", true));
                const { ctx } = u;
                ctx.save();
                ctx.strokeStyle = css("--text-2");
                ctx.setLineDash([6, 5]);
                ctx.lineWidth = 1.5 * devicePixelRatio;
                ctx.beginPath();
                ctx.moveTo(u.bbox.left, y);
                ctx.lineTo(u.bbox.left + u.bbox.width, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = css("--text-2");
                ctx.font = `${12 * devicePixelRatio}px ${css("--font-body") || "sans-serif"}`;
                ctx.fillText("tavoite", u.bbox.left + 4 * devicePixelRatio, y - 5 * devicePixelRatio);
                ctx.restore();
              },
            ],
          },
        },
        [xs, ...ys] as uPlot.AlignedData,
        el,
      );

    let chart = build();
    const ro = new ResizeObserver(() => chart.setSize({ width: el.clientWidth, height: 240 }));
    ro.observe(el);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const rebuild = () => {
      chart.destroy();
      chart = build();
    };
    mq.addEventListener("change", rebuild);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", rebuild);
      chart.destroy();
    };
  }, [props.series, props.points, props.targetCents]);

  if (props.points.length === 0) {
    return <div class="chart-empty">Hintahistoriaa ei vielä ole. Ensimmäinen haku tallentaa lähtötason.</div>;
  }
  return <div class="chart-wrap" ref={host} role="img" aria-label="Hintahistoria kaaviona; samat hinnat taulukkona alla" />;
}
