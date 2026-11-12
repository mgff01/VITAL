import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PASTA = path.join(process.cwd(), 'public', 'models');
const CANDIDATOS = ['vital.glb', 'vital.gltf', 'vital.stl', 'vital.obj'];

// Diz qual modelo 3D existe em public/models (ou null para usar o embutido)
// e o alinhamento salvo em public/models/vital.json: rotação [x, y, z] em
// graus que leva os eixos do modelo aos eixos do acelerômetro.
export async function GET() {
  const arquivo = CANDIDATOS.find((nome) => fs.existsSync(path.join(PASTA, nome))) ?? null;

  let alinhamento = [0, 0, 0];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(PASTA, 'vital.json'), 'utf8'));
    if (Array.isArray(config.alinhamento) && config.alinhamento.length === 3 && config.alinhamento.every(Number.isFinite)) {
      alinhamento = config.alinhamento;
    }
  } catch (err) {
    // sem vital.json: modelo usado como está
  }

  return NextResponse.json({ arquivo, alinhamento });
}
