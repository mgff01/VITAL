'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CircleDot, Download, OctagonAlert, Trash2, TriangleAlert } from 'lucide-react';
import CornerFrame from '@/components/CornerFrame';
import { BotaoExpandir, PainelExpandido } from '@/components/ExpandirGrafico';
import { COR_SEVERIDADE } from '@/components/ChartsPanel';
import { assinarRealtime } from '@/lib/realtimeCliente';

const HORA_MS = 3600 * 1000;
const PERIODOS = [
  { id: '24h', ms: 24 * HORA_MS, rotulo: '24 h' },
  { id: '7d', ms: 7 * 24 * HORA_MS, rotulo: '7 d' },
  { id: 'tudo', ms: null, rotulo: 'all' },
];
const SEVERIDADES = {
  leve: { rotulo: 'light', Icone: CircleDot },
  moderado: { rotulo: 'moderate', Icone: TriangleAlert },
  forte: { rotulo: 'severe', Icone: OctagonAlert },
};
const MAX_LINHAS = 100;
const TITULO_LINHA_DO_TEMPO = 'timeline · peak acceleration (g)';
const INTERVALO_MS = 10000;
const ESTILO_TICK = { fill: '#7A7A80', fontSize: 10, fontFamily: 'var(--font-plex-mono), monospace' };

function dataHora(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function tempoRelativo(ts, agora) {
  const s = Math.max(0, Math.round((agora - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function Selo({ severidade }) {
  const info = SEVERIDADES[severidade] ?? SEVERIDADES.leve;
  const cor = COR_SEVERIDADE[severidade] ?? COR_SEVERIDADE.leve;
  return (
    <span className="inline-flex items-center gap-1.5 border px-1.5 py-0.5" style={{ borderColor: cor }}>
      <info.Icone size={11} style={{ color: cor }} aria-hidden="true" />
      <span className="label-tracked text-ink">{info.rotulo}</span>
    </span>
  );
}

function Kpi({ titulo, valor, detalhe, alerta = false }) {
  return (
    <CornerFrame active={alerta} className="p-4">
      <div className="label-tracked text-ink-dim">{titulo}</div>
      <div className={`mono font-semibold mt-1.5 ${alerta ? 'text-alert' : 'text-ink'}`} style={{ fontSize: 26 }}>
        {valor}
      </div>
      {detalhe && <div className="mono text-[11px] text-ink-dim mt-0.5">{detalhe}</div>}
    </CornerFrame>
  );
}

function DicaPonto({ active, payload }) {
  if (!active || !payload?.length) {
    return null;
  }
  const i = payload[0].payload;
  return (
    <div className="border border-line-bright bg-void/95 px-3 py-2">
      <div className="mono text-[11px] text-ink-dim">{dataHora(i.timestamp)}</div>
      <div className="mono text-[13px] text-ink">
        {i.picoG.toFixed(2)} g · {i.eixo ?? '--'} · {i.duracaoMs ?? '--'} ms
      </div>
      <div className="mt-1">
        <Selo severidade={i.severidade} />
      </div>
    </div>
  );
}

function exportarCsv(impactos) {
  const campos = ['id', 'timestamp', 'severidade', 'picoG', 'duracaoMs', 'eixo', 'dx', 'dy', 'dz', 'inclAntes', 'inclDepois', 'tombou', 'saturado'];
  const valor = (v) => (v === null || v === undefined ? '' : v);
  const linhas = [
    campos.join(','),
    ...impactos.map((i) =>
      [
        i.id,
        new Date(i.timestamp).toISOString(),
        i.severidade,
        i.picoG,
        valor(i.duracaoMs),
        valor(i.eixo),
        valor(i.direcao?.x),
        valor(i.direcao?.y),
        valor(i.direcao?.z),
        valor(i.inclAntes),
        valor(i.inclDepois),
        i.tombou,
        i.saturado,
      ].join(',')
    ),
  ];
  const blob = new Blob([linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vital_impacts_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ImpactsPanel({ usbPlugado, portPath, limiarImpacto }) {
  const [impactos, setImpactos] = useState([]);
  const [limites, setLimites] = useState({ moderado: 1, forte: 1.5 });
  const [periodo, setPeriodo] = useState('24h');
  const [filtro, setFiltro] = useState('todos');
  const [novos, setNovos] = useState(() => new Set());
  const [agora, setAgora] = useState(() => Date.now());
  const [confirmarLimpar, setConfirmarLimpar] = useState(false);
  const [limiarForm, setLimiarForm] = useState('');
  const [feedback, setFeedback] = useState({ tipo: 'idle', mensagem: '' });
  const [linhaExpandida, setLinhaExpandida] = useState(false);
  const fecharLinha = useCallback(() => setLinhaExpandida(false), []);
  const timerConfirmar = useRef(null);

  const buscar = useCallback(async () => {
    try {
      const res = await fetch('/api/impacts', { cache: 'no-store' });
      const json = await res.json();
      setImpactos(json.impactos ?? []);
      if (json.limites) {
        setLimites(json.limites);
      }
      setAgora(Date.now());
    } catch (err) {
      // mantém a lista atual
    }
  }, []);

  useEffect(() => {
    buscar();
    const id = setInterval(buscar, INTERVALO_MS);
    const cancelar = assinarRealtime('impacto', (impacto) => {
      setNovos((anterior) => new Set(anterior).add(impacto.id));
      buscar();
    });
    return () => {
      clearInterval(id);
      cancelar();
    };
  }, [buscar]);

  useEffect(() => {
    if (typeof limiarImpacto === 'number' && limiarForm === '') {
      setLimiarForm(limiarImpacto.toFixed(2));
    }
  }, [limiarImpacto, limiarForm]);

  const periodoAtual = PERIODOS.find((p) => p.id === periodo);
  const desde = periodoAtual.ms ? agora - periodoAtual.ms : 0;
  const doPeriodo = useMemo(() => impactos.filter((i) => i.timestamp >= desde), [impactos, desde]);
  const filtrados = useMemo(
    () => (filtro === 'todos' ? doPeriodo : doPeriodo.filter((i) => i.severidade === filtro)),
    [doPeriodo, filtro]
  );

  const fortes = doPeriodo.filter((i) => i.severidade === 'forte').length;
  const maiorPico = doPeriodo.reduce((m, i) => Math.max(m, i.picoG), 0);
  const ultimo = impactos[0] ?? null;
  const inicioX = periodoAtual.ms ? desde : Math.min(agora - HORA_MS, ...doPeriodo.map((i) => i.timestamp));
  const maxY = Math.ceil(Math.max(2, maiorPico * 1.1) * 2) / 2; // múltiplo de 0,5 g
  const ticksY = Array.from({ length: maxY / 0.5 + 1 }, (_, i) => i * 0.5);

  const legendaSeveridade = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {Object.entries(SEVERIDADES).map(([chave, info]) => (
        <span key={chave} className="flex items-center gap-1.5">
          <info.Icone size={11} style={{ color: COR_SEVERIDADE[chave] }} aria-hidden="true" />
          <span className="label-tracked text-ink-dim">{info.rotulo}</span>
        </span>
      ))}
    </div>
  );

  function linhaDoTempo(expandido) {
    const tick = expandido ? { ...ESTILO_TICK, fontSize: 12 } : ESTILO_TICK;
    return doPeriodo.length === 0 ? (
      <div className={`flex items-center justify-center label-tracked text-ink-dim ${expandido ? 'flex-1' : 'h-[200px]'}`}>
        no impacts in this period
      </div>
    ) : (
      <div className={expandido ? 'min-h-[240px] flex-1' : ''}>
        <ResponsiveContainer width="100%" height={expandido ? '100%' : 220}>
          <ScatterChart margin={{ top: 8, right: 22, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e1e22" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={[inicioX, agora]}
              tickFormatter={(t) =>
                new Date(t).toLocaleString('pt-BR', periodo === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' })
              }
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: '#28282C' }}
              minTickGap={48}
            />
            <YAxis
              dataKey="picoG"
              type="number"
              domain={[0, maxY]}
              ticks={ticksY}
              width={40}
              tick={tick}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => v.toFixed(1)}
            />
            <ReferenceLine
              y={limites.forte}
              stroke="#48484E"
              label={{ value: 'severe', position: 'insideTopLeft', fill: '#7A7A80', fontSize: 10 }}
            />
            <ReferenceLine
              y={limites.moderado}
              stroke="#48484E"
              label={{ value: 'moderate', position: 'insideTopLeft', fill: '#7A7A80', fontSize: 10 }}
            />
            {typeof limiarImpacto === 'number' && (
              <ReferenceLine
                y={limiarImpacto}
                stroke="#48484E"
                strokeDasharray="3 3"
                label={{ value: 'threshold', position: 'insideBottomLeft', fill: '#7A7A80', fontSize: 10 }}
              />
            )}
            <Tooltip content={<DicaPonto />} cursor={false} isAnimationActive={false} />
            <Scatter
              data={doPeriodo}
              isAnimationActive={false}
              shape={({ cx, cy, payload }) => (
                <circle
                  cx={cx}
                  cy={cy}
                  r={expandido ? 6 : 5}
                  fill={COR_SEVERIDADE[payload.severidade] ?? COR_SEVERIDADE.leve}
                  stroke="#111113"
                  strokeWidth={2}
                />
              )}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  async function aplicarLimiar(evento) {
    evento.preventDefault();
    setFeedback({ tipo: 'loading', mensagem: 'Sending to ESP32...' });
    try {
      const res = await fetch('/api/device/impact-threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limiarG: limiarForm, portPath: portPath || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.erro ?? 'Falha ao ajustar o limiar');
      }
      setFeedback({ tipo: 'sucesso', mensagem: json.message });
    } catch (err) {
      setFeedback({ tipo: 'erro', mensagem: err instanceof Error ? err.message : 'Falha ao ajustar o limiar' });
    }
  }

  async function limpar() {
    if (!confirmarLimpar) {
      setConfirmarLimpar(true);
      clearTimeout(timerConfirmar.current);
      timerConfirmar.current = setTimeout(() => setConfirmarLimpar(false), 5000);
      return;
    }
    clearTimeout(timerConfirmar.current);
    setConfirmarLimpar(false);
    await fetch('/api/impacts', { method: 'DELETE' });
    setNovos(new Set());
    buscar();
  }

  return (
    <>
      {/* Filtros */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex" role="group" aria-label="Period">
            {PERIODOS.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className={`vital-button vital-button-sm ${i > 0 ? '-ml-px' : ''}`}
                aria-pressed={periodo === p.id}
                onClick={() => setPeriodo(p.id)}
              >
                {p.rotulo}
              </button>
            ))}
          </div>
          <div className="flex" role="group" aria-label="Severity">
            {['todos', 'leve', 'moderado', 'forte'].map((s, i) => (
              <button
                key={s}
                type="button"
                className={`vital-button vital-button-sm ${i > 0 ? '-ml-px' : ''}`}
                aria-pressed={filtro === s}
                onClick={() => setFiltro(s)}
              >
                {s === 'todos' ? 'all' : SEVERIDADES[s].rotulo}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className="vital-button vital-button-sm flex items-center gap-1.5"
            onClick={() => exportarCsv(filtrados)}
            disabled={filtrados.length === 0}
          >
            <Download size={12} /> CSV
          </button>
          <button
            type="button"
            className="vital-button vital-button-sm flex items-center gap-1.5"
            onClick={limpar}
            disabled={impactos.length === 0}
            style={confirmarLimpar ? { borderColor: '#FF4433', color: '#FF4433' } : undefined}
          >
            <Trash2 size={12} /> {confirmarLimpar ? `confirm: delete ${impactos.length}` : 'clear'}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 mb-3.5">
        <Kpi titulo={`impacts · ${periodoAtual.rotulo}`} valor={doPeriodo.length} />
        <Kpi titulo="severe" valor={fortes} alerta={fortes > 0} detalhe={`≥ ${limites.forte} g or saturated`} />
        <Kpi titulo="max peak" valor={doPeriodo.length ? `${maiorPico.toFixed(2)} g` : '--'} />
        <Kpi
          titulo="last impact"
          valor={ultimo ? tempoRelativo(ultimo.timestamp, agora) : '--'}
          detalhe={ultimo ? `${ultimo.picoG.toFixed(2)} g · ${dataHora(ultimo.timestamp)}` : 'none recorded'}
        />
      </div>

      {/* Linha do tempo */}
      <CornerFrame className="p-4 mb-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="label-tracked text-ink">{TITULO_LINHA_DO_TEMPO}</div>
          <div className="flex flex-wrap items-center gap-3">
            {legendaSeveridade}
            <BotaoExpandir titulo={TITULO_LINHA_DO_TEMPO} onClick={() => setLinhaExpandida(true)} />
          </div>
        </div>
        {linhaDoTempo(false)}
      </CornerFrame>
      {linhaExpandida ? (
        <PainelExpandido titulo={TITULO_LINHA_DO_TEMPO} onFechar={fecharLinha} acoes={legendaSeveridade}>
          {linhaDoTempo(true)}
        </PainelExpandido>
      ) : null}

      {/* Tabela */}
      <CornerFrame className="mb-3.5">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
          <div className="label-tracked text-ink">impact log</div>
          <span className="mono text-[11px] text-ink-dim">
            {filtrados.length > MAX_LINHAS ? `latest ${MAX_LINHAS} of ${filtrados.length}` : `${filtrados.length} events`}
          </span>
        </div>
        {filtrados.length === 0 ? (
          <div className="px-4 pb-6 pt-2 label-tracked text-ink-dim">
            no impacts recorded — tap the device firmly to test detection
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-y border-line">
                  {['time', 'severity', 'peak', 'duration', 'axis', 'tilt before → after', 'flags'].map((c) => (
                    <th key={c} className="label-tracked text-ink-dim font-semibold px-4 py-2 whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.slice(0, MAX_LINHAS).map((i) => (
                  <tr key={i.id} className={`border-b border-line ${novos.has(i.id) ? 'bg-amber/10' : ''}`}>
                    <td className="mono text-[12px] text-ink px-4 py-2 whitespace-nowrap">{dataHora(i.timestamp)}</td>
                    <td className="px-4 py-2">
                      <Selo severidade={i.severidade} />
                    </td>
                    <td className="mono text-[12px] text-ink px-4 py-2 whitespace-nowrap">
                      {i.picoG.toFixed(2)} g{i.saturado ? '+' : ''}
                    </td>
                    <td className="mono text-[12px] text-ink px-4 py-2">{i.duracaoMs ?? '--'} ms</td>
                    <td className="mono text-[12px] text-ink px-4 py-2">{i.eixo ?? '--'}</td>
                    <td className="mono text-[12px] text-ink px-4 py-2 whitespace-nowrap">
                      {typeof i.inclAntes === 'number' ? `${i.inclAntes.toFixed(1)}°` : '--'} →{' '}
                      {typeof i.inclDepois === 'number' ? `${i.inclDepois.toFixed(1)}°` : '--'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {i.tombou && <span className="label-tracked text-alert">tipped</span>}
                        {i.saturado && <span className="label-tracked text-ink-dim">≥2 g sat.</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CornerFrame>

      {/* Sensibilidade */}
      <CornerFrame active={usbPlugado} className="p-4 mb-3.5">
        <form onSubmit={aplicarLimiar} className="flex flex-wrap items-end gap-3">
          <div className="w-36">
            <label className="label-tracked text-ink-dim" htmlFor="limiar-impacto">
              threshold (g)
            </label>
            <input
              id="limiar-impacto"
              className="vital-input mt-1.5"
              type="number"
              min="0.1"
              max="3"
              step="0.05"
              value={limiarForm}
              onChange={(e) => setLimiarForm(e.target.value)}
              disabled={feedback.tipo === 'loading'}
            />
          </div>
          <button className="vital-button" type="submit" disabled={!usbPlugado || feedback.tipo === 'loading'}>
            {feedback.tipo === 'loading' ? 'Saving...' : 'Apply (USB)'}
          </button>
          <span
            className={`mono text-[11px] ${
              feedback.tipo === 'erro' ? 'text-alert' : feedback.tipo === 'sucesso' ? 'text-signal' : 'text-ink-dim'
            }`}
          >
            {feedback.mensagem ||
              `Device threshold: ${typeof limiarImpacto === 'number' ? `${limiarImpacto.toFixed(2)} g` : '--'}. ` +
                'Lower = more sensitive. Severity: light < 1.0 g ≤ moderate < 1.5 g ≤ severe.'}
          </span>
        </form>
      </CornerFrame>
    </>
  );
}
