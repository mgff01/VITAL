import { SerialPort } from 'serialport';

const BAUD_RATE = 115200;

// Conversores USB-serial comuns em placas ESP32: CH340 (1a86), CP210x (10c4),
// FTDI (0403) e o USB nativo da Espressif (303a).
const VENDOR_IDS_ESP32 = ['1a86', '10c4', '0403', '303a'];

function pareceEsp32(porta) {
  const vendorId = (porta.vendorId ?? '').toLowerCase();
  if (VENDOR_IDS_ESP32.includes(vendorId)) {
    return true;
  }
  const alvo = `${porta.path} ${porta.manufacturer ?? ''} ${porta.friendlyName ?? ''}`.toLowerCase();
  return (
    alvo.includes('esp32') ||
    alvo.includes('espressif') ||
    alvo.includes('ch340') ||
    alvo.includes('cp210') ||
    alvo.includes('usbmodem') ||
    alvo.includes('usbserial')
  );
}

export async function listarPortasSeriais() {
  const portas = await SerialPort.list();
  return portas
    .map((porta) => ({
      path: porta.path,
      manufacturer: porta.manufacturer ?? null,
      serialNumber: porta.serialNumber ?? null,
      vendorId: porta.vendorId ?? null,
      productId: porta.productId ?? null,
      likelyEsp32: pareceEsp32(porta),
    }))
    // prováveis ESP32 primeiro, para virarem o padrão no seletor do painel
    .sort((a, b) => Number(b.likelyEsp32) - Number(a.likelyEsp32));
}

export function escolherPorta(ports, portPath) {
  if (portPath) {
    return ports.find((porta) => porta.path === portPath) ?? null;
  }

  const candidatas = ports.filter((porta) => porta.likelyEsp32);
  if (candidatas.length > 0) {
    return candidatas[0];
  }

  return ports[0] ?? null;
}

// Envia uma linha de comando ao ESP32 e espera a resposta com ackPrefix
// (sucesso) ou errPrefix (falha), no protocolo descrito em firmware/.
export async function enviarComandoSerial({ path, comando, ackPrefix, errPrefix, timeoutMs = 9000 }) {
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
          if (linha.startsWith(ackPrefix)) {
            encerrar();
            resolve(linha);
            return;
          }
          if (linha.startsWith(errPrefix)) {
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

      porta.write(`${comando}\n`, (err) => {
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

export function enviarCredenciaisWiFiViaUsb({ path, ssid, password, timeoutMs }) {
  return enviarComandoSerial({
    path,
    comando: `WIFI_CONFIG|${ssid}|${password}`,
    ackPrefix: 'WIFI_CONFIG_OK|',
    errPrefix: 'WIFI_CONFIG_ERR|',
    timeoutMs,
  });
}

// Sensibilidade da detecção de impactos, em g (0,1 a 3,0).
export function ajustarLimiarImpactoViaUsb({ path, limiarG, timeoutMs = 5000 }) {
  return enviarComandoSerial({
    path,
    comando: `LIMIAR_IMPACTO|${limiarG}`,
    ackPrefix: 'LIMIAR_IMPACTO_OK|',
    errPrefix: 'LIMIAR_IMPACTO_ERR|',
    timeoutMs,
  });
}

export function calibrarInclinacaoViaUsb({ path, timeoutMs = 5000 }) {
  return enviarComandoSerial({
    path,
    comando: 'CALIBRAR',
    ackPrefix: 'CALIBRAR_OK|',
    errPrefix: 'CALIBRAR_ERR|',
    timeoutMs,
  });
}
