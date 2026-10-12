'use client';

import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { inr, inrCompact, shortDay } from '@/lib/format';

const VARS = ['--series-1', '--line', '--axis', '--muted', '--surface-2', '--ink', '--ink-2'] as const;
type ChartColors = Record<(typeof VARS)[number], string>;

/** SVG attributes can't reliably use var(), so read the resolved tokens (and follow light/dark switches). */
function useChartColors(): ChartColors {
  const read = (): ChartColors => {
    if (typeof window === 'undefined') return Object.fromEntries(VARS.map((v) => [v, '#888'])) as ChartColors;
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(VARS.map((v) => [v, style.getPropertyValue(v).trim()])) as ChartColors;
  };
  const [colors, setColors] = useState<ChartColors>(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setColors(read());
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return colors;
}

interface DayDatum {
  day: string;
  volume: number;
  succeeded: number;
  failed: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: DayDatum }>;
}

/** Value first (strong), label second; line key, not a box. */
function VolumeTooltip({ active, payload, color }: TooltipProps & { color: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{shortDay(d.day)}</div>
      <div className="flex items-center gap-2">
        <span className="h-0.5 w-3 rounded" style={{ background: color }} aria-hidden />
        <span className="text-sm font-semibold text-ink">{inr(d.volume)}</span>
        <span className="text-ink-2">gross volume</span>
      </div>
      <div className="mt-1 text-ink-2">
        {d.succeeded} succeeded · {d.failed} failed
      </div>
    </div>
  );
}

/** Single-series column chart: one hue, 4px rounded data-ends, ≤24px bars, hairline grid, hover tooltip. */
export function VolumeChart({ data }: { data: DayDatum[] }) {
  const c = useChartColors();
  return (
    <figure>
      <div className="h-64" role="img" aria-label="Column chart of daily gross volume">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={c['--line']} />
            <XAxis
              dataKey="day"
              tickFormatter={shortDay}
              tick={{ fill: c['--muted'], fontSize: 12 }}
              axisLine={{ stroke: c['--axis'] }}
              tickLine={false}
              minTickGap={20}
            />
            <YAxis tickFormatter={inrCompact} tick={{ fill: c['--muted'], fontSize: 12 }} axisLine={false} tickLine={false} width={60} />
            <Tooltip cursor={{ fill: c['--surface-2'] }} content={(props) => <VolumeTooltip {...(props as unknown as TooltipProps)} color={c['--series-1']} />} />
            <Bar dataKey="volume" fill={c['--series-1']} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-xs text-ink-2">
        <summary className="cursor-pointer select-none">View as table</summary>
        <table className="mt-2 w-full tabular">
          <thead>
            <tr className="text-muted">
              <th className="py-1 text-left font-medium">Day</th>
              <th className="py-1 text-right font-medium">Gross volume</th>
              <th className="py-1 text-right font-medium">Succeeded</th>
              <th className="py-1 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day} className="border-t border-line">
                <td className="py-1">{shortDay(d.day)}</td>
                <td className="py-1 text-right">{inr(d.volume)}</td>
                <td className="py-1 text-right">{d.succeeded}</td>
                <td className="py-1 text-right">{d.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Horizontal bars as plain HTML: single series, value labelled at the tip. */
export function BarList({ rows }: { rows: Array<{ label: string; value: number; display: string; sub?: string }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[88px_1fr] items-center gap-3 text-sm" title={`${r.label}: ${r.display}`}>
          <span className="truncate text-ink-2">{r.label}</span>
          <div className="flex items-center gap-2">
            <div className="h-3 rounded-r bg-series-1" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, maxWidth: 'calc(100% - 7rem)' }} />
            <span className="whitespace-nowrap font-medium tabular">{r.display}</span>
            {r.sub && <span className="whitespace-nowrap text-xs text-muted">{r.sub}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Meter: fill on a lighter track of the same hue. */
export function Meter({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="flex items-center gap-2" aria-label={label}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-series-1/20">
        <div className="h-full rounded-full bg-series-1" style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className="text-xs tabular text-ink-2">{(clamped * 100).toFixed(1)}%</span>
    </div>
  );
}
