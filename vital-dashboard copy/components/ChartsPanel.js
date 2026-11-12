'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download } from 'lucide-react';
import CornerFrame from '@/components/CornerFrame';
import { BotaoExpandir, PainelExpandido } from '@/components/ExpandirGrafico';

const JANELAS = [
  { s: 300, rotulo: '5 min' },
  { s: 900, rotulo: '15 min' },
  { s: 3600, rotulo: '1 h' },
];
const INTERVALO_MS = 5000;

// Séries únicas usam as cores da marca; séries múltiplas usam uma paleta
// validada para daltonismo sobre o fundo escuro (#111113).
const COR = {
  temperatura: '#FF7A1A',
  umidade: '#5FB8B0',
  s1: '#d95926',
  s2: '#3987e5',
  s3: '#199e70',
  grade: '#1e1e22',
  eixo: '#28282C',
  textoFraco: '#7A7A80',
};
export const COR_SEVERIDADE = { leve: '#7A7A80', moderado: '#FF7A1A', forte: '#FF4433' };

const ESTILO_TICK = { fill: COR.textoFraco, fontSize: 10, fontFamily: 'var(--font-plex-mono), monospace' };

function hora(ts, segundos = false) {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(segundos ? { second: '2-digit' } : {}),
  });
}

function estatisticas(pontos, campo) {
  const valores = pontos.map((p) => p[campo]).filter((v) => typeof v === 'number');
  if (valores.length === 0) {
    return null;
  }
  return {
    agora: valores[valores.length - 1],
    min: Math.min(...valores),
    media: valores.reduce((s, v) => s + v, 0) / valores.length,
    max: Math.max(...valores),
  };
}

function Dica({ active, payload, label, series }) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="border border-line-bright bg-void/95 px-3 py-2">
      <div className="mono text-[11px] text-ink-dim mb-1">{hora(label, true)}</div>
      {series.map((s) => {
        const item = payload.find((p) => p.dataKey === s.campo);
        const valor = item?.value;
        return (
          <div key={s.campo} className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3" style={{ background: s.cor }} />
            <span className="label-tracked text-ink-dim">{s.nome}</span>
            <span className="mono text-[12px] text-ink ml-auto pl-3">
              {typeof valor === 'number' ? `${valor.toFixed(s.casas)}${s.unidade}` : '--'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Legenda({ series, extra }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.campo} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: s.cor }} />
          <span className="label-tracked text-ink-dim">{s.nome}</span>
        </span>
      ))}
      {extra}
    </div>
  );
}

function LinhaEstatisticas({ stats, unidade, casas }) {
  const itens = [
    ['now', stats?.agora],
    ['min', stats?.min],
    ['avg', stats?.media],
    ['max', stats?.max],
  ];
  return (
    <div className="grid grid-cols-4 gap-2 border-t border-line pt-2.5 mt-2">
      {itens.map(([nome, valor]) => (
        <div key={nome}>
          <div className="label-tracked text-ink-dim">{nome}</div>
          <span className="mono text-[13px] text-ink">
            {typeof valor === 'number' ? `${valor.toFixed(casas)}${unidade}` : '--'}
          </span>
        </div>
      ))}
    </div>
  );
}

function Grafico({
  titulo,
  pontos,
  dominioX,
  series,
  altura = 200,
  dominioY = ['auto', 'auto'],
  area = false,
  impactos = [],
  casasEixo = 1,
  expandido = false,
  onExpandir,
}) {
  const comDados = pontos.filter((p) => series.some((s) => typeof p[s.campo] === 'number')).length >= 2;
  const tick = expandido ? { ...ESTILO_TICK, fontSize: 12 } : ESTILO_TICK;
  return (
    <div className={expandido ? 'flex min-h-0 flex-1 flex-col' : ''}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        {expandido ? null : <div className="label-tracked text-ink">{titulo}</div>}
        <div className="flex flex-wrap items-center gap-3">
          {series.length > 1 || impactos.length > 0 ? (
            <Legenda
              series={series}
              extra={
                impactos.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-px bg-alert" />
                    <span className="label-tracked text-ink-dim">impact</span>
                  </span>
                ) : null
              }
            />
          ) : null}
          {onExpandir ? <BotaoExpandir titulo={titulo} onClick={onExpandir} /> : null}
        </div>
      </div>
      {comDados ? (
        <div className={expandido ? 'min-h-[240px] flex-1' : ''}>
          <ResponsiveContainer width="100%" height={expandido ? '100%' : altura}>
            <ComposedChart data={pontos} margin={{ top: 6, right: 22, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={COR.grade} vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={dominioX}
                tickFormatter={(t) => hora(t)}
                tick={tick}
                tickLine={false}
                axisLine={{ stroke: COR.eixo }}
                minTickGap={48}
              />
              <YAxis
                width={expandido ? 54 : 46}
                domain={dominioY}
                tick={tick}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(casasEixo) : v)}
              />
              <Tooltip
                content={<Dica series={series} />}
                cursor={{ stroke: '#48484E', strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {impactos.map((i) => (
                <ReferenceLine
                  key={i.id}
                  x={i.timestamp}
                  stroke={COR_SEVERIDADE[i.severidade] ?? COR_SEVERIDADE.leve}
                  strokeOpacity={0.7}
                  ifOverflow="hidden"
                />
              ))}
              {series.map((s) =>
                area ? (
                  <Area
                    key={s.campo}
                    type="monotone"
                    dataKey={s.campo}
                    name={s.nome}
                    stroke={s.cor}
                    strokeWidth={2}
                    fill={s.cor}
                    fillOpacity={0.1}
                    dot={false}
                    activeDot={{ r: 4, stroke: '#111113', strokeWidth: 2 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                ) : (
                  <Line
                    key={s.campo}
                    type="monotone"
                    dataKey={s.campo}
                    name={s.nome}
                    stroke={s.cor}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, stroke: '#111113', strokeWidth: 2 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                )
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          style={expandido ? undefined : { height: altura }}
          className={`flex items-center justify-center label-tracked text-ink-dim ${expandido ? 'flex-1' : ''}`}
        >
          waiting for data
        </div>
      )}
    </div>
  );
}

function SeletorJanela({ janela, setJanela }) {
  return (
    <div className="flex" role="group" aria-label="Time range">
      {JANELAS.map((j, i) => (
        <button
          key={j.s}
          type="button"
          className={`vital-button vital-button-sm ${i > 0 ? '-ml-px' : ''}`}
          aria-pressed={janela === j.s}
          onClick={() => setJanela(j.s)}
        >
          {j.rotulo}
        </button>
      ))}
    </div>
  );
}

function exportarCsv(pontos, janela) {
  const campos = ['temperatura', 'umidade', 'inclinacao', 'pitch', 'roll', 'vibracao', 'pico'];
  const linhas = [
    ['timestamp', ...campos].join(','),
    ...pontos.map((p) =>
      [new Date(p.timestamp).toISOString(), ...campos.map((c) => (typeof p[c] === 'number' ? p[c] : ''))].join(',')
    ),
  ];
  const blob = new Blob([linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vital_${janela}s_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ChartsPanel() {
  const [janela, setJanela] = useState(900);
  const [dados, setDados] = useState({ pontos: [], impactos: [] });
  const [agora, setAgora] = useState(() => Date.now());
  const [expandido, setExpandido] = useState(null);
  const fechar = useCallback(() => setExpandido(null), []);

  useEffect(() => {
    let ativo = true;
    async function buscar() {
      try {
        const res = await fetch(`/api/history?janela=${janela}`, { cache: 'no-store' });
        const json = await res.json();
        if (ativo) {
          setDados({ pontos: json.pontos ?? [], impactos: json.impactos ?? [] });
          setAgora(Date.now());
        }
      } catch (err) {
        // mantém o último dado
      }
    }
    buscar();
    const id = setInterval(buscar, INTERVALO_MS);
    return () => {
      ativo = false;
      clearInterval(id);
    };
  }, [janela]);

  const { pontos, impactos } = dados;
  const dominioX = [agora - janela * 1000, agora];

  const temp = { campo: 'temperatura', nome: 'temp', cor: COR.temperatura, unidade: ' °C', casas: 1 };
  const umid = { campo: 'umidade', nome: 'humidity', cor: COR.umidade, unidade: ' %', casas: 0 };
  const orientacao = [
    { campo: 'inclinacao', nome: 'tilt', cor: COR.s1, unidade: '°', casas: 1 },
    { campo: 'pitch', nome: 'pitch', cor: COR.s2, unidade: '°', casas: 1 },
    { campo: 'roll', nome: 'roll', cor: COR.s3, unidade: '°', casas: 1 },
  ];
  const vibracao = [
    { campo: 'vibracao', nome: 'rms', cor: COR.s1, unidade: ' g', casas: 3 },
    { campo: 'pico', nome: 'peak', cor: COR.s2, unidade: ' g', casas: 3 },
  ];

  const graficos = {
    temperatura: {
      titulo: 'temperature (°C)',
      props: { series: [temp], area: true },
      stats: { campo: 'temperatura', unidade: '°', casas: 1 },
    },
    umidade: {
      titulo: 'humidity (%)',
      props: { series: [umid], area: true, casasEixo: 0 },
      stats: { campo: 'umidade', unidade: '%', casas: 0 },
    },
    orientacao: {
      titulo: 'orientation (°)',
      props: { series: orientacao, altura: 230, casasEixo: 0 },
      stats: { campo: 'inclinacao', unidade: '°', casas: 1 },
    },
    vibracao: {
      titulo: 'vibration (g)',
      props: { series: vibracao, altura: 230, dominioY: [0, 'auto'], impactos, casasEixo: 2 },
      stats: { campo: 'pico', unidade: ' g', casas: 3 },
    },
  };

  function cartao(id, className) {
    const g = graficos[id];
    return (
      <CornerFrame className={className}>
        <Grafico titulo={g.titulo} pontos={pontos} dominioX={dominioX} {...g.props} onExpandir={() => setExpandido(id)} />
        <LinhaEstatisticas stats={estatisticas(pontos, g.stats.campo)} unidade={g.stats.unidade} casas={g.stats.casas} />
      </CornerFrame>
    );
  }

  const aberto = expandido ? graficos[expandido] : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3.5">
        <SeletorJanela janela={janela} setJanela={setJanela} />
        <div className="flex items-center gap-3">
          <span className="mono text-[11px] text-ink-dim">
            {pontos.length} pts · {impactos.length} impacts · refresh 5 s
          </span>
          <button
            type="button"
            className="vital-button vital-button-sm flex items-center gap-1.5"
            onClick={() => exportarCsv(pontos, janela)}
            disabled={pontos.length === 0}
          >
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-3.5">
        {cartao('temperatura', 'p-4')}
        {cartao('umidade', 'p-4')}
      </div>
      {cartao('orientacao', 'p-4 mb-3.5')}
      {cartao('vibracao', 'p-4 mb-3.5')}

      {aberto ? (
        <PainelExpandido
          titulo={aberto.titulo}
          onFechar={fechar}
          acoes={<SeletorJanela janela={janela} setJanela={setJanela} />}
        >
          <Grafico titulo={aberto.titulo} pontos={pontos} dominioX={dominioX} {...aberto.props} expandido />
          <LinhaEstatisticas
            stats={estatisticas(pontos, aberto.stats.campo)}
            unidade={aberto.stats.unidade}
            casas={aberto.stats.casas}
          />
        </PainelExpandido>
      ) : null}
    </>
  );
}
