import { SerialPort } from 'serialport';

const BAUD_RATE = 115200;
const ACK_PREFIX = 'WIFI_CONFIG_OK|';
const ERR_PREFIX = 'WIFI_CONFIG_ERR|';

function pareceEsp32(porta) {
  const alvo = `${porta.path} ${porta.manufacturer ?? ''} ${porta.friendlyName ?? ''}`.toLowerCase();
  return alvo.includes('esp32') || alvo.includes('espressif') || alvo.includes('usbmodem') || alvo.includes('usbserial');
}

export async function listarPortasSeriais() {
  const portas = await SerialPort.list();
  return portas.map((porta) => ({
    path: porta.path,
    manufacturer: porta.manufacturer ?? null,
    serialNumber: porta.serialNumber ?? null,
    vendorId: porta.vendorId ?? null,
    productId: porta.productId ?? null,
    likelyEsp32: pareceEsp32(porta),
  }));
}

export async function enviarCredenciaisWiFiViaUsb({ path, ssid, password, timeoutMs = 9000 }) {
  const comando = `WIFI_CONFIG|${ssid}|${password}\n`;
  const porta = new SerialPort({
    path,
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  let respostaParcial = '';
  let timeoutId = null;

  const fecharPorta = async () => {
    if (!porta.isOpen) {
      return;
    }
    await new Promise((resolve) => porta.close(() => resolve()));
  };

  try {
    await new Promise((resolve, reject) => {
      porta.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    const resposta = await new Promise((resolve, reject) => {
      const encerrar = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        porta.off('data', onData);
        porta.off('error', onError);
      };

      const onError = (err) => {
        encerrar();
        reject(err);
      };

      const onData = (chunk) => {
        respostaParcial += chunk.toString('utf8');
        const linhas = respostaParcial.split(/\r?\n/);
        respostaParcial = linhas.pop() ?? '';

        for (const linhaBruta of linhas) {
          const linha = linhaBruta.trim();
          if (!linha) {
            continue;
          }
          if (linha.startsWith(ACK_PREFIX)) {
            encerrar();
            resolve(linha);
            return;
          }
          if (linha.startsWith(ERR_PREFIX)) {
            encerrar();
            reject(new Error(linha));
            return;
          }
        }
      };

      timeoutId = setTimeout(() => {
        encerrar();
        reject(new Error('Timeout aguardando confirmação do ESP32 via USB'));
      }, timeoutMs);

      porta.on('data', onData);
      porta.on('error', onError);

      porta.write(comando, (err) => {
        if (err) {
          encerrar();
          reject(err);
          return;
        }
        porta.drain((drainErr) => {
          if (drainErr) {
            encerrar();
            reject(drainErr);
          }
        });
      });
    });

    return resposta;
  } finally {
    await fecharPorta();
  }
}
