'use client';

import { LineChart, Line, ResponsiveContainer, YAxis, CartesianGrid } from 'recharts';

export default function HistoryChart({ data, dataKey, color, height = 90, domain = ['dataMin - 2', 'dataMax + 2'] }) {
  const pontosValidos = data ? data.filter((ponto) => typeof ponto[dataKey] === 'number').length : 0;
  if (pontosValidos < 2) {
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
        <YAxis hide domain={domain} />
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
