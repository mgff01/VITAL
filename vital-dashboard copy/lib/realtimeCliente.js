'use client';

// Uma única conexão SSE (/api/stream) por aba do navegador, compartilhada
// entre a visualização 3D e a aba de impactos. Fecha sozinha quando ninguém
// mais está ouvindo.

const ouvintes = { amostra: new Set(), impacto: new Set(), status: new Set() };
let fonte = null;
let timerFechar = null;

function totalOuvintes() {
  return ouvintes.amostra.size + ouvintes.impacto.size + ouvintes.status.size;
}

function distribuir(tipo, dados) {
  for (const ouvinte of ouvintes[tipo]) {
    ouvinte(dados);
  }
}

function abrir() {
  clearTimeout(timerFechar);
  if (fonte || typeof window === 'undefined') {
    return;
  }
  fonte = new EventSource('/api/stream');
  for (const tipo of Object.keys(ouvintes)) {
    fonte.addEventListener(tipo, (evento) => {
      try {
        distribuir(tipo, JSON.parse(evento.data));
      } catch (err) {
        // mensagem malformada: ignora
      }
    });
  }
  // o EventSource reconecta sozinho se o servidor reiniciar
}

function fecharSeOcioso() {
  clearTimeout(timerFechar);
  timerFechar = setTimeout(() => {
    if (fonte && totalOuvintes() === 0) {
      fonte.close();
      fonte = null;
    }
  }, 2000);
}

export function assinarRealtime(tipo, ouvinte) {
  ouvintes[tipo].add(ouvinte);
  abrir();
  return () => {
    ouvintes[tipo].delete(ouvinte);
    fecharSeOcioso();
  };
}
