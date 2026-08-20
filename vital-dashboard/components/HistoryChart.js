'use client';

import { LineChart, Line, ResponsiveContainer, YAxis, CartesianGrid } from 'recharts';

export default function HistoryChart({ data, dataKey, color, height = 90 }) {
  if (!data || data.length < 2) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center label-tracked text-ink-dim"
      >
        aguardando dados
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="#28282C" strokeDasharray="2 4" vertical={false} />
        <YAxis hide domain={['dataMin - 2', 'dataMax + 2']} />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
