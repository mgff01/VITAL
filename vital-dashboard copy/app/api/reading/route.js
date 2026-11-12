import { NextResponse } from 'next/server';
import { adicionarImpactos, adicionarLeitura, obterEstado } from '@/lib/store';
import { garantirRealtime, publicarImpactos } from '@/lib/realtime';

export const runtime = 'nodejs';

// O ESP32 chama este endpoint via POST a cada 3 s, enviando:
// {
//   "temperatura": 24.6, "umidade": 58.2,              // DHT11 (null se falhar)
//   "motionState": 12, "inclinado": false,              // 0..100 a partir do ângulo
//   "inclinacao": 10.8, "pitch": -3.1, "roll": 10.4,    // graus (LIS3DH/LIS3DSH)
//   "ax": -0.054, "ay": 0.187, "az": 0.979,             // g
//   "vibracao": 0.012, "pico": 0.041,                   // g (RMS e pico da janela)
//   "dhtOk": true, "acelerometroOk": true,
//   "limiarImpacto": 0.5, "ms": 123456,                 // millis() do ESP32
//   "eventos": [{ "id": "a1b2c3d4-120000", "ms": 120000, "duracaoMs": 80, "picoG": 1.2,
//                 "dx": 0.1, "dy": -1.1, "dz": 0.3, "inclAntes": 2.0, "inclDepois": 2.4,
//                 "saturado": false }]
// }
export async function POST(request) {
  garantirRealtime();

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 });
  }

  // Um sensor pode falhar sozinho; só rejeita se nenhum mandou dado.
  const temDht = typeof body.temperatura === 'number' && typeof body.umidade === 'number';
  const temAcelerometro = typeof body.motionState === 'number' || typeof body.ax === 'number';
  if (!temDht && !temAcelerometro) {
    return NextResponse.json(
      { erro: 'Envie "temperatura"/"umidade" (DHT11) e/ou dados do acelerômetro como números' },
      { status: 400 }
    );
  }

  const leitura = adicionarLeitura(body);
  const impactosNovos = adicionarImpactos(body.eventos, body.ms);
  publicarImpactos(impactosNovos);

  return NextResponse.json({ ok: true, leitura, impactosNovos: impactosNovos.length });
}

// O dashboard (front-end) chama isso via GET, com polling, para atualizar a tela.
export async function GET() {
  garantirRealtime();
  return NextResponse.json(obterEstado());
}
