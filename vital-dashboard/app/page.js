'use client';

import { useState, useEffect } from 'react';
import { Wifi, WifiOff, TriangleAlert } from 'lucide-react';
import CornerFrame from '@/components/CornerFrame';
import HistoryChart from '@/components/HistoryChart';

const INTERVALO_POLLING_MS = 3000;
const INTERVALO_USB_MS = 5000;

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

export default function Dashboard() {
  const [estado, setEstado] = useState({ conectado: false, ultimaLeitura: null, historico: [] });
  const [estadoUsb, setEstadoUsb] = useState({ pluggedIn: false, ports: [] });
  const [wifiForm, setWifiForm] = useState({ ssid: '', password: '', portPath: '' });
  const [wifiFeedback, setWifiFeedback] = useState({ tipo: 'idle', mensagem: 'USB required: plug ESP32 to change Wi-Fi.' });
  const [relogio, setRelogio] = useState(new Date());
  const [inicioSessao] = useState(Date.now());

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
  }));

  const motionState = Number(leitura?.motionState ?? (leitura?.inclinado ? 100 : 0));
  const tilt = motionState >= 50;
  const temSinal = estado.conectado;
  const usbPlugado = estadoUsb.pluggedIn;
  const enviandoWifi = wifiFeedback.tipo === 'loading';

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

  return (
    <div className="min-h-screen bg-void px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {/* Cabeçalho */}
        <div className="flex items-baseline justify-between border-b border-line pb-3.5 mb-5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display font-bold text-2xl tracking-[0.12em]">VITAL</span>
            <span className="mono text-xs text-ink-dim">ESP32-01</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              {temSinal ? <Wifi size={13} className="text-amber" /> : <WifiOff size={13} className="text-ink-dim" />}
              <span className={`label-tracked ${temSinal ? 'text-ink' : 'text-ink-dim'}`}>
                {temSinal ? 'linked' : 'offline'}
              </span>
            </div>
            <span className="mono text-[13px] text-ink-dim">{formatarHora(relogio)}</span>
          </div>
        </div>

        {/* Hero: temperatura */}
        <CornerFrame active={temSinal} className="p-5 sm:p-6 mb-3.5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="label-tracked text-ink-dim">surface temp</div>
              <div className="flex items-end gap-2 mt-1.5">
                <span className="mono font-semibold text-amber" style={{ fontSize: 64 }}>
                  {leitura ? leitura.temperatura.toFixed(1) : '--.-'}
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
                {leitura ? leitura.umidade.toFixed(0) : '--'}
              </span>
              <span className="mono text-signal-dim text-sm">%</span>
            </div>
          </CornerFrame>

          <CornerFrame active={tilt} className="p-4">
            <div className="label-tracked text-ink-dim">motion state</div>
            <div className="flex items-center gap-2 mt-2">
              {tilt && <TriangleAlert size={16} className="text-alert" />}
              <span className={`mono font-semibold ${tilt ? 'text-alert' : 'text-ink'}`} style={{ fontSize: 20 }}>
                {!leitura ? '----' : `${Math.round(motionState)}%`}
              </span>
            </div>
            <div className="mt-1 mono text-[11px] text-ink-dim">
              {!leitura ? 'WAITING' : tilt ? 'DETECTED' : 'STABLE'}
            </div>
          </CornerFrame>

          <CornerFrame className="p-4">
            <div className="label-tracked text-ink-dim">samples</div>
            <div className="mt-2">
              <span className="mono font-semibold" style={{ fontSize: 32 }}>
                {estado.historico.length}
              </span>
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
        </div>

        <CornerFrame active={usbPlugado} className="p-4 mb-3.5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="label-tracked text-ink-dim">wifi setup (usb only)</div>
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
        </CornerFrame>

        {/* Rodapé técnico */}
        <div className="flex flex-wrap justify-between gap-2 pt-3 border-t border-line mono text-[11px] text-ink-dim">
          <span>NODE ESP32-01</span>
          <span>PROTOCOL HTTP/POST</span>
          <span>POLL {INTERVALO_POLLING_MS / 1000}s</span>
          <span>UPTIME {formatarUptime(Date.now() - inicioSessao)}</span>
        </div>
      </div>
    </div>
  );
}
