import { NextResponse } from 'next/server';
import { calibrarInclinacaoViaUsb, escolherPorta, listarPortasSeriais } from '@/lib/serialDevice';

export const runtime = 'nodejs';

// Grava a posição atual do LIS3DH como referência (0°) de inclinação.
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    // corpo opcional: sem portPath, escolhe a porta mais provável
  }

  try {
    const ports = await listarPortasSeriais();
    const portaSelecionada = escolherPorta(ports, typeof body.portPath === 'string' ? body.portPath : '');
    if (!portaSelecionada) {
      return NextResponse.json(
        { erro: 'ESP32 não detectado via USB. Plugue o dispositivo para calibrar.' },
        { status: 409 }
      );
    }

    const resposta = await calibrarInclinacaoViaUsb({ path: portaSelecionada.path });

    return NextResponse.json({
      ok: true,
      message: `Referência de inclinação gravada (${portaSelecionada.path}).`,
      resposta,
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : 'Falha ao calibrar via USB';
    return NextResponse.json({ erro: mensagem }, { status: 500 });
  }
}
