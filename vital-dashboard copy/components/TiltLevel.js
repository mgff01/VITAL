// Nível de bolha: a bolha se desloca com roll (eixo X) e pitch (eixo Y),
// limitada a ±45° na borda. Anéis em 15°, 30° e 45°.
const ANGULO_BORDA = 45;
const TAMANHO = 132;
const CENTRO = TAMANHO / 2;
const RAIO = 56;

function limitar(valor) {
  return Math.max(-ANGULO_BORDA, Math.min(ANGULO_BORDA, valor));
}

export default function TiltLevel({ pitch, roll, alerta = false }) {
  const temDado = typeof pitch === 'number' && typeof roll === 'number';
  const bolhaX = CENTRO + (temDado ? (limitar(roll) / ANGULO_BORDA) * RAIO : 0);
  const bolhaY = CENTRO + (temDado ? (limitar(pitch) / ANGULO_BORDA) * RAIO : 0);
  const corBolha = alerta ? '#FF4433' : '#FF7A1A';

  return (
    <svg width={TAMANHO} height={TAMANHO} viewBox={`0 0 ${TAMANHO} ${TAMANHO}`} role="img" aria-label="nível de inclinação">
      {[1, 2 / 3, 1 / 3].map((fracao) => (
        <circle
          key={fracao}
          cx={CENTRO}
          cy={CENTRO}
          r={RAIO * fracao}
          fill="none"
          stroke={fracao === 1 ? '#48484E' : '#28282C'}
          strokeDasharray={fracao === 1 ? undefined : '2 4'}
        />
      ))}
      <line x1={CENTRO - RAIO} y1={CENTRO} x2={CENTRO + RAIO} y2={CENTRO} stroke="#28282C" />
      <line x1={CENTRO} y1={CENTRO - RAIO} x2={CENTRO} y2={CENTRO + RAIO} stroke="#28282C" />
      {temDado && (
        <>
          <line x1={CENTRO} y1={CENTRO} x2={bolhaX} y2={bolhaY} stroke={corBolha} strokeOpacity="0.35" />
          <circle cx={bolhaX} cy={bolhaY} r="7" fill={corBolha} fillOpacity="0.2" stroke={corBolha} strokeWidth="1.5" />
          <circle cx={bolhaX} cy={bolhaY} r="1.5" fill={corBolha} />
        </>
      )}
    </svg>
  );
}
