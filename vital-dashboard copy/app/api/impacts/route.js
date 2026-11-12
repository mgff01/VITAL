import { NextResponse } from 'next/server';
import { LIMITES_SEVERIDADE, limparImpactos, obterImpactos } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/impacts?desde=<timestamp ms>  ->  lista do mais recente ao mais antigo
export async function GET(request) {
  const desde = Number(new URL(request.url).searchParams.get('desde') ?? 0);
  return NextResponse.json({
    impactos: obterImpactos({ desde: Number.isFinite(desde) ? desde : 0 }),
    limites: LIMITES_SEVERIDADE,
  });
}

// DELETE /api/impacts  ->  apaga o histórico de impactos (data/impactos.json)
export async function DELETE() {
  const removidos = limparImpactos();
  return NextResponse.json({ ok: true, removidos });
}
