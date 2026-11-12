// Recebe o stream UDP do ESP32 (orientação a 20 Hz) e repassa para quem
// estiver ouvindo (rota /api/stream, via Server-Sent Events).
//
// Pacote do firmware:  V,<seq>,<ms>,<gx>,<gy>,<gz>,<dinamica_max_g>,<inclinacao>
// (inclinação -1 = sem referência)

import dgram from 'node:dgram';

export const PORTA_UDP = 4210;

// globalThis: o hot-reload do Next.js reimporta este módulo; sem isso o
// socket tentaria abrir a porta de novo (EADDRINUSE).
const global = globalThis;

function iniciar() {
  const estado = {
    ultimaAmostra: null,
    pacotes: 0,
    perdidos: 0,
    ultimaSeq: null,
    ouvintes: new Set(),
    erro: null,
    escutando: false,
  };

  const socket = dgram.createSocket('udp4');

  socket.on('message', (mensagem, remetente) => {
    const partes = mensagem.toString('utf8').trim().split(',');
    if (partes[0] !== 'V' || partes.length < 8) {
      return;
    }
    const numeros = partes.slice(1).map(Number);
    if (numeros.some((n) => !Number.isFinite(n))) {
      return;
    }
    const [seq, ms, gx, gy, gz, dinamica, inclinacao] = numeros;

    if (estado.ultimaSeq !== null && seq > estado.ultimaSeq + 1) {
      estado.perdidos += seq - estado.ultimaSeq - 1;
    }
    estado.ultimaSeq = seq;
    estado.pacotes += 1;

    const amostra = {
      t: Date.now(),
      seq,
      ms,
      gx,
      gy,
      gz,
      dinamica,
      inclinacao: inclinacao < 0 ? null : inclinacao,
      origem: remetente.address,
    };
    estado.ultimaAmostra = amostra;
    publicar({ tipo: 'amostra', dados: amostra });
  });

  socket.on('error', (err) => {
    estado.erro = err.message;
    estado.escutando = false;
  });

  socket.on('listening', () => {
    estado.escutando = true;
    estado.erro = null;
  });

  socket.bind(PORTA_UDP);
  return estado;
}

function obterEstadoInterno() {
  if (!global.__vitalRealtime) {
    global.__vitalRealtime = iniciar();
  }
  return global.__vitalRealtime;
}

function publicar(mensagem) {
  for (const ouvinte of obterEstadoInterno().ouvintes) {
    try {
      ouvinte(mensagem);
    } catch (err) {
      // um ouvinte com conexão fechada não pode derrubar os outros
    }
  }
}

// Garante que o socket UDP está aberto (chamado pelas rotas da API).
export function garantirRealtime() {
  obterEstadoInterno();
}

export function assinar(ouvinte) {
  const estado = obterEstadoInterno();
  estado.ouvintes.add(ouvinte);
  return () => estado.ouvintes.delete(ouvinte);
}

// Impactos chegam pelo HTTP (confiável) e são avisados ao vivo por aqui.
export function publicarImpactos(impactos) {
  for (const impacto of impactos) {
    publicar({ tipo: 'impacto', dados: impacto });
  }
}

export function statusRealtime() {
  const { ultimaAmostra, pacotes, perdidos, erro, escutando } = obterEstadoInterno();
  return { ultimaAmostra, pacotes, perdidos, erro, escutando, porta: PORTA_UDP };
}
