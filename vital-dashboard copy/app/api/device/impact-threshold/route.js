import { NextResponse } from 'next/server';
import { ajustarLimiarImpactoViaUsb, escolherPorta, listarPortasSeriais } from '@/lib/serialDevice';

export const runtime = 'nodejs';

// Body: { limiarG: 0.5, portPath?: "COM3" }  -> grava a sensibilidade no ESP32 (NVS)
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 });
  }

  const limiarG = Number(String(body.limiarG ?? '').replace(',', '.'));
  if (!Number.isFinite(limiarG) || limiarG < 0.1 || limiarG > 3) {
    return NextResponse.json({ erro: 'O limiar deve ficar entre 0,1 e 3,0 g.' }, { status: 400 });
  }

  try {
    const ports = await listarPortasSeriais();
    const porta = escolherPorta(ports, typeof body.portPath === 'string' ? body.portPath : '');
    if (!porta) {
      return NextResponse.json(
        { erro: 'ESP32 não detectado via USB. Plugue o dispositivo para mudar a sensibilidade.' },
        { status: 409 }
      );
    }
    const resposta = await ajustarLimiarImpactoViaUsb({ path: porta.path, limiarG: limiarG.toFixed(2) });
    return NextResponse.json({
      ok: true,
      message: `Impact threshold set to ${resposta.split('|')[1]} g (${porta.path}).`,
      resposta,
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : 'Falha ao ajustar o limiar via USB';
    return NextResponse.json({ erro: mensagem }, { status: 500 });
  }
}
