import { NextResponse } from 'next/server';
import { enviarCredenciaisWiFiViaUsb, listarPortasSeriais } from '@/lib/serialWifi';

export const runtime = 'nodejs';

function escolherPorta(ports, portPath) {
  if (portPath) {
    return ports.find((porta) => porta.path === portPath) ?? null;
  }

  const candidatas = ports.filter((porta) => porta.likelyEsp32);
  if (candidatas.length > 0) {
    return candidatas[0];
  }

  return ports[0] ?? null;
}

export async function GET() {
  try {
    const ports = await listarPortasSeriais();
    return NextResponse.json({
      pluggedIn: ports.length > 0,
      ports,
    });
  } catch (err) {
    return NextResponse.json(
      { erro: 'Falha ao listar portas seriais. Verifique permissões USB.' },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 });
  }

  const { ssid, password, portPath } = body;

  if (typeof ssid !== 'string' || ssid.trim().length === 0) {
    return NextResponse.json({ erro: 'Campo "ssid" é obrigatório' }, { status: 400 });
  }
  if (typeof password !== 'string') {
    return NextResponse.json({ erro: 'Campo "password" deve ser string' }, { status: 400 });
  }

  try {
    const ports = await listarPortasSeriais();
    if (ports.length === 0) {
      return NextResponse.json(
        { erro: 'ESP32 não detectado via USB. Plugue o dispositivo para alterar o Wi-Fi.' },
        { status: 409 }
      );
    }

    const portaSelecionada = escolherPorta(ports, typeof portPath === 'string' ? portPath : '');
    if (!portaSelecionada) {
      return NextResponse.json(
        { erro: 'Porta serial selecionada não está disponível' },
        { status: 400 }
      );
    }

    await enviarCredenciaisWiFiViaUsb({
      path: portaSelecionada.path,
      ssid: ssid.trim(),
      password,
    });

    return NextResponse.json({
      ok: true,
      message: `Credenciais enviadas via USB (${portaSelecionada.path}). O ESP32 está reconectando.`,
      portPath: portaSelecionada.path,
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : 'Falha ao enviar credenciais via USB';
    return NextResponse.json({ erro: mensagem }, { status: 500 });
  }
}
