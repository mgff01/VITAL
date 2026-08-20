import { NextResponse } from 'next/server';
import { adicionarLeitura, obterEstado } from '@/lib/store';

// O ESP32 chama este endpoint via POST a cada poucos segundos, enviando:
// { "temperatura": 24.6, "umidade": 58.2, "inclinado": false }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 });
  }

  const { temperatura, umidade, inclinado, motionState } = body;

  if (typeof temperatura !== 'number' || typeof umidade !== 'number') {
    return NextResponse.json(
      { erro: 'Campos "temperatura" e "umidade" são obrigatórios e devem ser números' },
      { status: 400 }
    );
  }

  const leitura = adicionarLeitura({ temperatura, umidade, inclinado, motionState });
  return NextResponse.json({ ok: true, leitura });
}

// O dashboard (front-end) chama isso via GET, com polling, para atualizar a tela.
export async function GET() {
  const estado = obterEstado();
  return NextResponse.json(estado);
}
