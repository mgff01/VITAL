'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Wifi, WifiOff, TriangleAlert, Activity, Crosshair } from 'lucide-react';
import CornerFrame from '@/components/CornerFrame';
import HistoryChart from '@/components/HistoryChart';
import TiltLevel from '@/components/TiltLevel';
import ChartsPanel from '@/components/ChartsPanel';
import ImpactsPanel from '@/components/ImpactsPanel';

// three.js só roda no navegador
const Vital3D = dynamic(() => import('@/components/Vital3D'), {
  ssr: false,
  loading: () => <div className="h-[380px] sm:h-[520px] flex items-center justify-center label-tracked text-ink-dim">loading 3d</div>,
});

const ABAS = [
  { id: 'overview', rotulo: 'overview' },
  { id: '3d', rotulo: '3d view' },
  { id: 'charts', rotulo: 'charts' },
  { id: 'impacts', rotulo: 'impacts' },
];

const INTERVALO_POLLING_MS = 3000;
const INTERVALO_USB_MS = 5000;
const LIMIAR_VIBRACAO_G = 0.05; // RMS acima disso = em movimento
const FAIXA_EIXO_G = 2; // LIS3DH configurado em ±2 g

function formatarHora(date) {
  return date.toLocaleTimeString('pt-BR', { hour12: false });
}

function formatarUptime(ms) {
  const totalSegundos = Math.floor(ms / 1000);
  const horas = String(Math.floor(totalSegundos / 3600)).padStart(2, '0');
  const minutos = String(Math.floor((totalSegundos % 3600) / 60)).padStart(2, '0');
  const segundos = String(totalSegundos % 60).padStart(2, '0');
  return `${horas}:${minutos}:${segundos}`;
}

function formatarNumero(valor, casas, vazio) {
  return typeof valor === 'number' ? valor.toFixed(casas) : vazio;
}

function formatarSinal(valor, casas, vazio) {
  if (typeof valor !== 'number') {
    return vazio;
  }
  return `${valor >= 0 ? '+' : ''}${valor.toFixed(casas)}`;
}

function SensorChip({ nome, ok, temLeitura }) {
  const cor = !temLeitura ? 'bg-line-bright' : ok ? 'bg-signal' : 'bg-alert';
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${cor}`} />
      <span className={`mono text-[11px] ${temLeitura && !ok ? 'text-alert' : 'text-ink-dim'}`}>{nome}</span>
    </span>
  );
}

function AxisBar({ eixo, valor }) {
  const temDado = typeof valor === 'number';
  const fracao = temDado ? Math.max(-1, Math.min(1, valor / FAIXA_EIXO_G)) : 0;
  const largura = `${Math.abs(fracao) * 50}%`;
  const inicio = fracao >= 0 ? '50%' : `${50 - Math.abs(fracao) * 50}%`;

  return (
    <div className="flex items-center gap-3">
      <span className="label-tracked text-ink-dim w-3">{eixo}</span>
      <div className="relative h-1.5 flex-1 bg-void border border-line">
        <span className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px bg-line-bright" />
        {temDado && <span className="absolute top-0 bottom-0 bg-amber" style={{ left: inicio, width: largura }} />}
      </div>
      <span className="mono text-[13px] text-ink w-16 text-right">{formatarSinal(valor, 3, '--.---')}</span>
    </div>
  );
}

export default function Dashboard() {
  const [estado, setEstado] = useState({ conectado: false, ultimaLeitura: null, historico: [] });
  const [estadoUsb, setEstadoUsb] = useState({ pluggedIn: false, ports: [] });
  const [wifiForm, setWifiForm] = useState({ ssid: '', password: '', portPath: '' });
  const [wifiFeedback, setWifiFeedback] = useState({ tipo: 'idle', mensagem: 'USB required: plug ESP32 to change Wi-Fi.' });
  const [calibracao, setCalibracao] = useState({ tipo: 'idle', mensagem: '' });
  const [relogio, setRelogio] = useState(new Date());
  const [inicioSessao] = useState(Date.now());
  const [aba, setAba] = useState('overview');

  // a aba fica na URL (#3d, #charts...) para sobreviver ao recarregar a página
  useEffect(() => {
    const lerHash = () => {
      const hash = window.location.hash.replace('#', '');
      setAba(ABAS.some((a) => a.id === hash) ? hash : 'overview');
    };
    lerHash();
    window.addEventListener('hashchange', lerHash);
    return () => window.removeEventListener('hashchange', lerHash);
  }, []);

  function trocarAba(id) {
    setAba(id);
    window.history.replaceState(null, '', id === 'overview' ? window.location.pathname : `#${id}`);
  }

  useEffect(() => {
    async function buscar() {
      try {
        const res = await fetch('/api/reading', { cache: 'no-store' });
        const dados = await res.json();
        setEstado(dados);
      } catch (err) {
        // mantém o último estado conhecido; o indicador "conectado" já
        // vem calculado pelo servidor com base no timeout
      }
    }
    buscar();
    const id = setInterval(buscar, INTERVALO_POLLING_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setRelogio(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    async function buscarEstadoUsb() {
      try {
        const res = await fetch('/api/device/wifi', { cache: 'no-store' });
        if (!res.ok) {
          return;
        }
        const dados = await res.json();
        setEstadoUsb(dados);
        setWifiForm((anterior) => {
          if (anterior.portPath && dados.ports.some((p) => p.path === anterior.portPath)) {
            return anterior;
          }
          return { ...anterior, portPath: dados.ports[0]?.path ?? '' };
        });
      } catch (err) {
        // mantém o último estado USB conhecido
      }
    }

    buscarEstadoUsb();
    const id = setInterval(buscarEstadoUsb, INTERVALO_USB_MS);
    return () => clearInterval(id);
  }, []);

  const leitura = estado.ultimaLeitura;
  const historicoGrafico = estado.historico.map((h) => ({
    t: h.timestamp,
    temperatura: h.temperatura,
    umidade: h.umidade,
    inclinacao: h.inclinacao ?? null,
    vibracao: h.vibracao ?? null,
  }));

  const motionState = typeof leitura?.motionState === 'number' ? leitura.motionState : null;
  const inclinacao = leitura?.inclinacao ?? null;
  const tilt = leitura?.inclinado ?? (motionState !== null && motionState >= 50);
  const vibracao = leitura?.vibracao ?? null;
  const emMovimento = typeof vibracao === 'number' && vibracao >= LIMIAR_VIBRACAO_G;
  const acelerometroOk = leitura?.acelerometroOk ?? false;
  const dhtOk = leitura?.dhtOk ?? false;

  const temSinal = estado.conectado;
  const resumoImpactos = estado.resumoImpactos ?? { total: 0, ultimas24h: 0, ultimo: null };
  const ultimoImpacto = resumoImpactos.ultimo;
  const impactoRecente = ultimoImpacto && Date.now() - ultimoImpacto.timestamp < 60 * 1000;
  const usbPlugado = estadoUsb.pluggedIn;
  const enviandoWifi = wifiFeedback.tipo === 'loading';
  const calibrando = calibracao.tipo === 'loading';

  async function enviarCredenciaisWiFi(event) {
    event.preventDefault();
    if (!usbPlugado) {
      setWifiFeedback({
        tipo: 'erro',
        mensagem: 'ESP32 não detectado via USB. Plugue o cabo para habilitar essa função.',
      });
      return;
    }

    if (!wifiForm.ssid.trim()) {
      setWifiFeedback({ tipo: 'erro', mensagem: 'SSID is required.' });
      return;
    }

    setWifiFeedback({ tipo: 'loading', mensagem: 'Sending credentials to ESP32...' });

    try {
      const res = await fetch('/api/device/wifi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssid: wifiForm.ssid,
          password: wifiForm.password,
          portPath: wifiForm.portPath || undefined,
        }),
      });
      const dados = await res.json();

      if (!res.ok) {
        throw new Error(dados.erro ?? 'Falha ao atualizar Wi-Fi');
      }

      setWifiFeedback({
        tipo: 'sucesso',
        mensagem: dados.message ?? 'Wi-Fi updated successfully.',
      });
    } catch (err) {
      setWifiFeedback({
        tipo: 'erro',
        mensagem: err instanceof Error ? err.message : 'Falha ao atualizar Wi-Fi',
      });
    }
  }

  async function calibrarInclinacao() {
    setCalibracao({ tipo: 'loading', mensagem: 'Calibrating...' });
    try {
      const res = await fetch('/api/device/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portPath: wifiForm.portPath || undefined }),
      });
      const dados = await res.json();
      if (!res.ok) {
        throw new Error(dados.erro ?? 'Falha ao calibrar');
      }
      setCalibracao({ tipo: 'sucesso', mensagem: dados.message ?? 'Reference saved.' });
    } catch (err) {
      setCalibracao({ tipo: 'erro', mensagem: err instanceof Error ? err.message : 'Falha ao calibrar' });
    }
  }

  return (
    <div className="min-h-screen bg-void px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {/* Cabeçalho */}
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3.5 mb-5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display font-bold text-2xl tracking-[0.12em]">VITAL</span>
            <span className="mono text-xs text-ink-dim">ESP32-WROVER</span>
          </div>
          <div className="flex items-center gap-4">
            <SensorChip nome="DHT11" ok={dhtOk} temLeitura={Boolean(leitura)} />
            <SensorChip nome="LIS3DH" ok={acelerometroOk} temLeitura={Boolean(leitura)} />
            <div className="flex items-center gap-1.5">
              {temSinal ? <Wifi size={13} className="text-amber" /> : <WifiOff size={13} className="text-ink-dim" />}
              <span className={`label-tracked ${temSinal ? 'text-ink' : 'text-ink-dim'}`}>
                {temSinal ? 'linked' : 'offline'}
              </span>
            </div>
            <span className="mono text-[13px] text-ink-dim" suppressHydrationWarning>
              {formatarHora(relogio)}
            </span>
          </div>
        </div>

        {/* Abas */}
        <div role="tablist" aria-label="Sections" className="flex flex-wrap gap-x-6 border-b border-line -mt-2 mb-5">
          {ABAS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={aba === a.id}
              className="vital-tab flex items-center gap-1.5"
              onClick={() => trocarAba(a.id)}
            >
              {a.rotulo}
              {a.id === 'impacts' && resumoImpactos.ultimas24h > 0 && (
                <span className={`mono text-[10px] px-1 ${impactoRecente ? 'bg-alert text-void' : 'bg-line text-ink'}`}>
                  {resumoImpactos.ultimas24h}
                </span>
              )}
            </button>
          ))}
        </div>

        {aba === '3d' && <Vital3D leitura={leitura} limiarImpacto={leitura?.limiarImpacto ?? null} />}

        {aba === 'charts' && <ChartsPanel />}

        {aba === 'impacts' && (
          <ImpactsPanel
            usbPlugado={usbPlugado}
            portPath={wifiForm.portPath}
            limiarImpacto={leitura?.limiarImpacto ?? null}
          />
        )}

        {aba === 'overview' && (
        <>
        {/* Hero: temperatura */}
        <CornerFrame active={temSinal} className="p-5 sm:p-6 mb-3.5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="label-tracked text-ink-dim">surface temp</div>
              <div className="flex items-end gap-2 mt-1.5">
                <span className="mono font-semibold text-amber" style={{ fontSize: 64 }}>
                  {formatarNumero(leitura?.temperatura, 1, '--.-')}
                </span>
                <span className="mono text-amber-dim" style={{ fontSize: 20 }}>°C</span>
              </div>
            </div>
            <div className="w-full sm:w-56">
              <HistoryChart data={historicoGrafico} dataKey="temperatura" color="#FF7A1A" />
            </div>
          </div>
        </CornerFrame>

        {/* Grade de status */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-3.5">
          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim">humidity</div>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="mono font-semibold text-signal" style={{ fontSize: 32 }}>
                {formatarNumero(leitura?.umidade, 0, '--')}
              </span>
              <span className="mono text-signal-dim text-sm">%</span>
            </div>
          </CornerFrame>

          <CornerFrame active={tilt} className="p-4">
            <div className="label-tracked text-ink-dim">motion state</div>
            <div className="flex items-center gap-2 mt-2">
              {tilt && <TriangleAlert size={16} className="text-alert" />}
              <span className={`mono font-semibold ${tilt ? 'text-alert' : 'text-ink'}`} style={{ fontSize: 20 }}>
                {motionState === null ? '----' : `${Math.round(motionState)}%`}
              </span>
              {typeof inclinacao === 'number' && (
                <span className="mono text-[13px] text-ink-dim">{inclinacao.toFixed(1)}°</span>
              )}
            </div>
            <div className="mt-2 h-1 bg-void border border-line">
              <div
                className={tilt ? 'h-full bg-alert' : 'h-full bg-amber'}
                style={{ width: `${motionState ?? 0}%` }}
              />
            </div>
            <div className="mt-1.5 mono text-[11px] text-ink-dim">
              {motionState === null ? 'WAITING' : tilt ? 'DETECTED' : 'STABLE'}
            </div>
          </CornerFrame>

          <CornerFrame active={impactoRecente} className="p-4">
            <button
              type="button"
              className="w-full text-left"
              onClick={() => trocarAba('impacts')}
              aria-label="Open impact history"
            >
              <div className="label-tracked text-ink-dim">impacts · 24h</div>
              <div className="flex items-baseline gap-2 mt-2">
                <span className={`mono font-semibold ${impactoRecente ? 'text-alert' : 'text-ink'}`} style={{ fontSize: 32 }}>
                  {resumoImpactos.ultimas24h}
                </span>
                {ultimoImpacto && (
                  <span className="mono text-[13px] text-ink-dim">last {ultimoImpacto.picoG.toFixed(2)} g</span>
                )}
              </div>
              <div className="mt-1.5 mono text-[11px] text-ink-dim">
                {ultimoImpacto
                  ? `AT ${new Date(ultimoImpacto.timestamp).toLocaleTimeString('pt-BR', { hour12: false })}`
                  : 'NONE RECORDED'}
              </div>
            </button>
          </CornerFrame>
        </div>

        {/* Acelerômetro LIS3DH */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-3.5">
          <CornerFrame active={tilt} className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="label-tracked text-ink-dim">orientation · lis3dh</div>
              <Crosshair size={13} className="text-ink-dim" />
            </div>
            <div className="flex items-center gap-5">
              <TiltLevel pitch={leitura?.pitch} roll={leitura?.roll} alerta={tilt} />
              <div className="flex flex-col gap-3">
                <div>
                  <div className="label-tracked text-ink-dim">tilt</div>
                  <span className={`mono font-semibold ${tilt ? 'text-alert' : 'text-amber'}`} style={{ fontSize: 26 }}>
                    {formatarNumero(inclinacao, 1, '--.-')}°
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <div className="label-tracked text-ink-dim">pitch</div>
                    <span className="mono text-[15px]">{formatarSinal(leitura?.pitch, 1, '--.-')}°</span>
                  </div>
                  <div>
                    <div className="label-tracked text-ink-dim">roll</div>
                    <span className="mono text-[15px]">{formatarSinal(leitura?.roll, 1, '--.-')}°</span>
                  </div>
                </div>
              </div>
            </div>
          </CornerFrame>

          <CornerFrame active={emMovimento} className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="label-tracked text-ink-dim">acceleration (g)</div>
              <Activity size={13} className={emMovimento ? 'text-amber' : 'text-ink-dim'} />
            </div>
            <div className="flex flex-col gap-2.5">
              <AxisBar eixo="x" valor={leitura?.ax} />
              <AxisBar eixo="y" valor={leitura?.ay} />
              <AxisBar eixo="z" valor={leitura?.az} />
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-line">
              <div>
                <div className="label-tracked text-ink-dim">vibration</div>
                <span className={`mono text-[15px] ${emMovimento ? 'text-amber' : 'text-ink'}`}>
                  {formatarNumero(vibracao, 3, '-.---')}
                </span>
              </div>
              <div>
                <div className="label-tracked text-ink-dim">peak</div>
                <span className="mono text-[15px]">{formatarNumero(leitura?.pico, 3, '-.---')}</span>
              </div>
              <div>
                <div className="label-tracked text-ink-dim">state</div>
                <span className="mono text-[11px] text-ink-dim">
                  {vibracao === null ? 'WAITING' : emMovimento ? 'MOVING' : 'STILL'}
                </span>
              </div>
            </div>
          </CornerFrame>
        </div>

        {/* Gráficos de histórico */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-3.5">
          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim mb-2">temp history</div>
            <HistoryChart data={historicoGrafico} dataKey="temperatura" color="#FF7A1A" />
          </CornerFrame>
          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim mb-2">humidity history</div>
            <HistoryChart data={historicoGrafico} dataKey="umidade" color="#5FB8B0" />
          </CornerFrame>
          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim mb-2">tilt history (°)</div>
            <HistoryChart data={historicoGrafico} dataKey="inclinacao" color="#E9E7E2" domain={[0, 'dataMax + 5']} />
          </CornerFrame>
          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim mb-2">vibration history (g rms)</div>
            <HistoryChart data={historicoGrafico} dataKey="vibracao" color="#FF4433" domain={[0, 'dataMax']} />
          </CornerFrame>
        </div>

        <CornerFrame active={usbPlugado} className="p-4 mb-3.5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="label-tracked text-ink-dim">device setup (usb only)</div>
            <span className={`mono text-[11px] ${usbPlugado ? 'text-signal' : 'text-ink-dim'}`}>
              {usbPlugado ? 'ESP32 PLUGGED' : 'USB DISCONNECTED'}
            </span>
          </div>

          <form onSubmit={enviarCredenciaisWiFi} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label-tracked text-ink-dim">ssid</label>
              <input
                className="vital-input mt-1.5"
                type="text"
                value={wifiForm.ssid}
                onChange={(event) => setWifiForm((anterior) => ({ ...anterior, ssid: event.target.value }))}
                placeholder="MyNetwork"
                disabled={enviandoWifi}
              />
            </div>
            <div>
              <label className="label-tracked text-ink-dim">password</label>
              <input
                className="vital-input mt-1.5"
                type="password"
                value={wifiForm.password}
                onChange={(event) => setWifiForm((anterior) => ({ ...anterior, password: event.target.value }))}
                placeholder="********"
                disabled={enviandoWifi}
              />
            </div>
            <div>
              <label className="label-tracked text-ink-dim">serial port</label>
              <select
                className="vital-input mt-1.5"
                value={wifiForm.portPath}
                onChange={(event) => setWifiForm((anterior) => ({ ...anterior, portPath: event.target.value }))}
                disabled={enviandoWifi || estadoUsb.ports.length === 0}
              >
                {estadoUsb.ports.length === 0 && <option value="">No serial ports</option>}
                {estadoUsb.ports.map((porta) => (
                  <option key={porta.path} value={porta.path}>
                    {porta.path}
                    {porta.likelyEsp32 ? ' · ESP32' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
              <button className="vital-button" type="submit" disabled={!usbPlugado || enviandoWifi}>
                {enviandoWifi ? 'SENDING...' : 'APPLY WIFI'}
              </button>
              <span
                className={`mono text-[11px] ${
                  wifiFeedback.tipo === 'erro'
                    ? 'text-alert'
                    : wifiFeedback.tipo === 'sucesso'
                      ? 'text-signal'
                      : 'text-ink-dim'
                }`}
              >
                {wifiFeedback.mensagem}
              </span>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t border-line">
            <button
              className="vital-button"
              type="button"
              onClick={calibrarInclinacao}
              disabled={!usbPlugado || calibrando || enviandoWifi}
            >
              {calibrando ? 'CALIBRATING...' : 'ZERO TILT'}
            </button>
            <span
              className={`mono text-[11px] ${
                calibracao.tipo === 'erro' ? 'text-alert' : calibracao.tipo === 'sucesso' ? 'text-signal' : 'text-ink-dim'
              }`}
            >
              {calibracao.mensagem || 'Saves the current LIS3DH position as 0°. Keep the device still.'}
            </span>
          </div>
        </CornerFrame>
        </>
        )}

        {/* Rodapé técnico */}
        <div className="flex flex-wrap justify-between gap-2 pt-3 border-t border-line mono text-[11px] text-ink-dim">
          <span>NODE ESP32-01</span>
          <span>DHT11 IO4 · LIS3DH/LIS3DSH I²C IO32/IO33</span>
          <span>POLL {INTERVALO_POLLING_MS / 1000}s</span>
          <span>UPTIME {formatarUptime(Date.now() - inicioSessao)}</span>
        </div>
      </div>
    </div>
  );
}
