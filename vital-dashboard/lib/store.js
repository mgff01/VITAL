// Armazenamento simples em memória. Reinicia se o servidor Next.js reiniciar
// (comportamento esperado para um painel local de hobby ligado à sua rede).
// Se um dia precisar manter histórico entre reinicializações, troque isto
// por um arquivo JSON ou um banco (ex: SQLite).

const MAX_HISTORICO = 200;

// globalThis evita que o hot-reload do Next.js em modo dev zere o histórico
// a cada salvamento de arquivo.
const estadoGlobal = globalThis;
if (!estadoGlobal.__vitalStore) {
  estadoGlobal.__vitalStore = {
    historico: [],
    ultimaLeitura: null,
    ultimaVezRecebido: null,
  };
}

const store = estadoGlobal.__vitalStore;

export function adicionarLeitura({ temperatura, umidade, inclinado, motionState }) {
  const valorMotionState =
    typeof motionState === 'number' ? Number(motionState) : typeof inclinado === 'boolean' ? (inclinado ? 100 : 0) : null;

  const leitura = {
    timestamp: Date.now(),
    temperatura: typeof temperatura === 'number' ? temperatura : null,
    umidade: typeof umidade === 'number' ? umidade : null,
    inclinado: typeof inclinado === 'boolean' ? inclinado : valorMotionState >= 50,
    motionState: typeof valorMotionState === 'number' ? Math.max(0, Math.min(100, valorMotionState)) : null,
  };

  store.historico.push(leitura);
  if (store.historico.length > MAX_HISTORICO) {
    store.historico.shift();
  }

  store.ultimaLeitura = leitura;
  store.ultimaVezRecebido = Date.now();

  return leitura;
}

export function obterEstado() {
  const AGORA = Date.now();
  const TIMEOUT_OFFLINE_MS = 15000; // se não chegar dado em 15s, considera offline

  const conectado =
    store.ultimaVezRecebido !== null && AGORA - store.ultimaVezRecebido < TIMEOUT_OFFLINE_MS;

  return {
    conectado,
    ultimaLeitura: store.ultimaLeitura,
    historico: store.historico,
  };
}
