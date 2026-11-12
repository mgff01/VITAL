import { NextResponse } from 'next/server';
import { obterHistorico, obterImpactos } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JANELAS_S = { 300: true, 900: true, 3600: true };

// GET /api/history?janela=900  ->  { janela, pontos: [...], impactos: [...] }
// janela em segundos: 300 (5 min), 900 (15 min) ou 3600 (1 h).
export async function GET(request) {
  const pedida = Number(new URL(request.url).searchParams.get('janela') ?? 900);
  const janela = JANELAS_S[pedida] ? pedida : 900;
  const janelaMs = janela * 1000;

  return NextResponse.json({
    janela,
    pontos: obterHistorico(janelaMs),
    impactos: obterImpactos({ desde: Date.now() - janelaMs }),
  });
}
