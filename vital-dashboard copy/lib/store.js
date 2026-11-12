// Armazenamento do painel.
// - Leituras: em memória, última 1 h (reinicia junto com o servidor Next.js).
// - Impactos/colisões: em memória + arquivo data/impactos.json, para o
//   histórico sobreviver a reinicializações.

import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORICO = 1200; // 1 h com uma leitura a cada 3 s
const MAX_RECENTES = 200; // o que a visão geral recebe a cada polling
const MAX_IMPACTOS = 2000;
const TIMEOUT_OFFLINE_MS = 15000; // se não chegar dado em 15 s, considera offline
const ARQUIVO_IMPACTOS = path.join(process.cwd(), 'data', 'impactos.json');

// Severidade pelo pico da aceleração dinâmica (g). Com o sensor em ±2 g,
// um pico saturado é sempre "forte".
export const LIMITES_SEVERIDADE = { moderado: 1.0, forte: 1.5 };
const VARIACAO_TOMBAMENTO_GRAUS = 30;

function carregarImpactos() {
  try {
    const conteudo = JSON.parse(fs.readFileSync(ARQUIVO_IMPACTOS, 'utf8'));
    return Array.isArray(conteudo) ? conteudo : [];
  } catch (err) {
    return [];
  }
}

function salvarImpactos(impactos) {
  try {
    fs.mkdirSync(path.dirname(ARQUIVO_IMPACTOS), { recursive: true });
    fs.writeFileSync(ARQUIVO_IMPACTOS, JSON.stringify(impactos, null, 1));
  } catch (err) {
    console.error('[VITAL] não consegui salvar data/impactos.json:', err.message);
  }
}

// globalThis evita que o hot-reload do Next.js em modo dev zere o histórico
// a cada salvamento de arquivo.
const estadoGlobal = globalThis;
if (!estadoGlobal.__vitalStore) {
  const impactos = carregarImpactos();
  estadoGlobal.__vitalStore = {
    historico: [],
    ultimaLeitura: null,
    ultimaVezRecebido: null,
    impactos,
    idsImpactos: new Set(impactos.map((i) => i.id)),
  };
}
const store = estadoGlobal.__vitalStore;
// versões antigas do store (antes dos impactos) continuam vivas no hot-reload
if (!store.impactos) {
  store.impactos = carregarImpactos();
  store.idsImpactos = new Set(store.impactos.map((i) => i.id));
}

function numeroOuNulo(valor) {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function limitar(valor, min, max) {
  return valor === null ? null : Math.max(min, Math.min(max, valor));
}

export function adicionarLeitura(dados) {
  const motionStateRecebido = numeroOuNulo(dados.motionState);
  const valorMotionState =
    motionStateRecebido ?? (typeof dados.inclinado === 'boolean' ? (dados.inclinado ? 100 : 0) : null);

  const temperatura = numeroOuNulo(dados.temperatura);
  const umidade = numeroOuNulo(dados.umidade);
  const ax = numeroOuNulo(dados.ax);

  const leitura = {
    timestamp: Date.now(),
    temperatura,
    umidade,
    motionState: limitar(valorMotionState, 0, 100),
    inclinado: typeof dados.inclinado === 'boolean' ? dados.inclinado : valorMotionState !== null && valorMotionState >= 50,
    // LIS3DH / LIS3DSH
    inclinacao: limitar(numeroOuNulo(dados.inclinacao), 0, 180),
    pitch: numeroOuNulo(dados.pitch),
    roll: numeroOuNulo(dados.roll),
    ax,
    ay: numeroOuNulo(dados.ay),
    az: numeroOuNulo(dados.az),
    vibracao: numeroOuNulo(dados.vibracao),
    pico: numeroOuNulo(dados.pico),
    limiarImpacto: numeroOuNulo(dados.limiarImpacto),
    // firmwares antigos não mandam os flags: deduz pela presença dos valores
    dhtOk: typeof dados.dhtOk === 'boolean' ? dados.dhtOk : temperatura !== null && umidade !== null,
    acelerometroOk: typeof dados.acelerometroOk === 'boolean' ? dados.acelerometroOk : ax !== null,
  };

  store.historico.push(leitura);
  if (store.historico.length > MAX_HISTORICO) {
    store.historico.splice(0, store.historico.length - MAX_HISTORICO);
  }

  store.ultimaLeitura = leitura;
  store.ultimaVezRecebido = Date.now();

  return leitura;
}

// ---------------------------------------------------------------------------
// Impactos
// ---------------------------------------------------------------------------

export function classificarSeveridade(picoG, saturado) {
  if (saturado || picoG >= LIMITES_SEVERIDADE.forte) {
    return 'forte';
  }
  if (picoG >= LIMITES_SEVERIDADE.moderado) {
    return 'moderado';
  }
  return 'leve';
}

function eixoDominante(x, y, z) {
  const eixos = [
    ['X', x],
    ['Y', y],
    ['Z', z],
  ].filter(([, v]) => v !== null);
  if (eixos.length === 0) {
    return null;
  }
  const [nome, valor] = eixos.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return `${valor >= 0 ? '+' : '-'}${nome}`;
}

// eventos: lista enviada pelo ESP32; msDispositivo: millis() do ESP32 no envio,
// usado para converter o instante do impacto para o relógio do servidor.
export function adicionarImpactos(eventos, msDispositivo) {
  if (!Array.isArray(eventos) || eventos.length === 0) {
    return [];
  }
  const agora = Date.now();
  const msEnvio = numeroOuNulo(msDispositivo);
  const novos = [];

  for (const e of eventos) {
    if (!e || typeof e.id !== 'string' || store.idsImpactos.has(e.id)) {
      continue; // reenvio de um impacto que já chegou
    }
    const picoG = numeroOuNulo(e.picoG);
    if (picoG === null) {
      continue;
    }
    const msEvento = numeroOuNulo(e.ms);
    const idadeMs = msEnvio !== null && msEvento !== null ? Math.max(0, msEnvio - msEvento) : 0;
    const dx = numeroOuNulo(e.dx);
    const dy = numeroOuNulo(e.dy);
    const dz = numeroOuNulo(e.dz);
    const inclAntes = numeroOuNulo(e.inclAntes);
    const inclDepois = numeroOuNulo(e.inclDepois);
    const variacao = inclAntes !== null && inclDepois !== null ? inclDepois - inclAntes : null;
    const saturado = e.saturado === true;

    const impacto = {
      id: e.id,
      timestamp: agora - idadeMs,
      picoG,
      duracaoMs: numeroOuNulo(e.duracaoMs),
      direcao: { x: dx, y: dy, z: dz },
      eixo: eixoDominante(dx, dy, dz),
      inclAntes,
      inclDepois,
      variacaoInclinacao: variacao,
      tombou: variacao !== null && Math.abs(variacao) >= VARIACAO_TOMBAMENTO_GRAUS,
      saturado,
      severidade: classificarSeveridade(picoG, saturado),
    };
    store.idsImpactos.add(impacto.id);
    novos.push(impacto);
  }

  if (novos.length > 0) {
    store.impactos.push(...novos);
    store.impactos.sort((a, b) => a.timestamp - b.timestamp);
    if (store.impactos.length > MAX_IMPACTOS) {
      const removidos = store.impactos.splice(0, store.impactos.length - MAX_IMPACTOS);
      removidos.forEach((i) => store.idsImpactos.delete(i.id));
    }
    salvarImpactos(store.impactos);
  }
  return novos;
}

export function obterImpactos({ desde = 0 } = {}) {
  return store.impactos.filter((i) => i.timestamp >= desde).slice().reverse();
}

export function limparImpactos() {
  const total = store.impactos.length;
  store.impactos = [];
  store.idsImpactos = new Set();
  salvarImpactos(store.impactos);
  return total;
}

function resumoImpactos() {
  const desde24h = Date.now() - 24 * 3600 * 1000;
  const ultimo = store.impactos[store.impactos.length - 1] ?? null;
  return {
    total: store.impactos.length,
    ultimas24h: store.impactos.filter((i) => i.timestamp >= desde24h).length,
    ultimo,
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export function obterEstado() {
  const conectado =
    store.ultimaVezRecebido !== null && Date.now() - store.ultimaVezRecebido < TIMEOUT_OFFLINE_MS;

  return {
    conectado,
    ultimaLeitura: store.ultimaLeitura,
    historico: store.historico.slice(-MAX_RECENTES),
    totalAmostras: store.historico.length,
    resumoImpactos: resumoImpactos(),
  };
}

const CAMPOS_MEDIA = ['temperatura', 'umidade', 'inclinacao', 'pitch', 'roll', 'vibracao'];

// Série de uma janela de tempo, reduzida a no máximo maxPontos por média
// em blocos (o pico de vibração usa o máximo do bloco, para não sumir).
export function obterHistorico(janelaMs, maxPontos = 360) {
  const desde = Date.now() - janelaMs;
  const pontos = store.historico.filter((l) => l.timestamp >= desde);
  if (pontos.length <= maxPontos) {
    return pontos;
  }

  const tamanho = Math.ceil(pontos.length / maxPontos);
  const reduzidos = [];
  for (let i = 0; i < pontos.length; i += tamanho) {
    const bloco = pontos.slice(i, i + tamanho);
    const ponto = { timestamp: bloco[Math.floor(bloco.length / 2)].timestamp };
    for (const campo of CAMPOS_MEDIA) {
      const valores = bloco.map((l) => l[campo]).filter((v) => typeof v === 'number');
      ponto[campo] = valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : null;
    }
    const picos = bloco.map((l) => l.pico).filter((v) => typeof v === 'number');
    ponto.pico = picos.length ? Math.max(...picos) : null;
    reduzidos.push(ponto);
  }
  return reduzidos;
}
