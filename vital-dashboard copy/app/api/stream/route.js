import { assinar, statusRealtime } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INTERVALO_MIN_AMOSTRA_MS = 33; // no máximo ~30 amostras/s por navegador
const INTERVALO_PING_MS = 15000;

// Server-Sent Events: orientação ao vivo (evento "amostra") e impactos
// (evento "impacto") para a visualização 3D e a aba de impactos.
export async function GET(request) {
  const codificador = new TextEncoder();
  let encerrar = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let aberto = true;
      let ultimoEnvio = 0;

      const escrever = (texto) => {
        if (!aberto) {
          return;
        }
        try {
          controller.enqueue(codificador.encode(texto));
        } catch (err) {
          encerrar();
        }
      };

      const enviar = ({ tipo, dados }) => {
        if (tipo === 'amostra') {
          const agora = Date.now();
          if (agora - ultimoEnvio < INTERVALO_MIN_AMOSTRA_MS) {
            return;
          }
          ultimoEnvio = agora;
        }
        escrever(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
      };

      const status = statusRealtime();
      escrever(`event: status\ndata: ${JSON.stringify({ ...status, ultimaAmostra: undefined })}\n\n`);
      if (status.ultimaAmostra) {
        enviar({ tipo: 'amostra', dados: status.ultimaAmostra });
      }

      const cancelarAssinatura = assinar(enviar);
      const ping = setInterval(() => escrever(': ping\n\n'), INTERVALO_PING_MS);

      encerrar = () => {
        if (!aberto) {
          return;
        }
        aberto = false;
        cancelarAssinatura();
        clearInterval(ping);
        try {
          controller.close();
        } catch (err) {
          // já fechado
        }
      };
      request.signal.addEventListener('abort', encerrar);
    },
    cancel() {
      encerrar();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
