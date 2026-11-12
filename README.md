# VITAL Painel de monitoramento — temperatura, umidade, inclinação e vibração.
<img width="1844" height="730" alt="image" src="https://github.com/user-attachments/assets/131fc629-7087-49cc-9e6a-329258efc6c4" />

🖨️ Caixa para impressão 3D: [modelo no Printables](https://www.printables.com/model/1911580-vital-esp32-monitor-enclosure-temperature-humidity)

---

## Requisitos do projeto

- Node.js 18+ e npm (ou pnpm/yarn) para rodar o dashboard localmente.
- Acesso à rede local onde o ESP32 está conectado (mesma sub-rede para o
  envio HTTP do dispositivo ao servidor do dashboard).
- Permissões para acessar portas seriais (apenas quando usar a feature
  "wifi setup (usb only)"). No macOS/Linux pode ser necessário ajustar
  permissões do dispositivo USB ou executar o servidor com privilégios que
  permitam acesso à porta serial.
- (Opcional) Ferramentas para compilar e gravar o firmware do ESP32
  (ESP-IDF/PlatformIO/Arduino IDE) para atualizar o código embarcado.

Dependências principais (declared em vital-dashboard/package.json):
- next, react, react-dom — para o dashboard (Next.js)
- recharts — gráficos de histórico
- lucide-react — ícones
- serialport — integração local via USB (para enviar SSID/senha ao ESP32)

---

## Lista de especificações

- Endpoint de leitura (ESP32 -> dashboard):
  - Método: POST
  - URL: /api/reading
  - Payload JSON esperado (campos de um sensor que falhou vão como `null`;
    o endpoint só rejeita se nenhum sensor mandar dado):
    - temperatura: number (°C) — DHT11
    - umidade: number (%) — DHT11
    - motionState: number (0..100) — inclinação em relação à posição de
      referência, onde 90° = 100 (LIS3DH)
    - inclinado: boolean — true a partir de 30° de inclinação
    - inclinacao: number (°) — ângulo em relação à referência
    - pitch, roll: number (°) — orientação absoluta
    - ax, ay, az: number (g) — aceleração por eixo (faixa ±2 g)
    - vibracao: number (g) — RMS da aceleração dinâmica entre dois envios
    - pico: number (g) — pico da aceleração dinâmica entre dois envios
    - dhtOk, acelerometroOk: boolean — saúde de cada sensor

- Calibração de inclinação (USB-only):
  - Botão "zero tilt" no painel envia `CALIBRAR\n`; o ESP32 grava a posição
    atual como 0° em NVS e responde `CALIBRAR_OK|x=..,y=..,z=..` ou
    `CALIBRAR_ERR|<motivo>`.
  - Sem calibração salva, a referência é a posição em que a placa ligou.

- Polling do dashboard para atualizar a UI:
  - Intervalo: 3 segundos (frontend faz GET em /api/reading)
  - Timeout para considerar o dispositivo offline: 15 segundos sem leituras

- Histórico:
  - O servidor mantém até 200 amostras em memória (lib/store.js).
  - O histórico é reiniciado quando o servidor Next.js reinicia (intencional).

- Wi‑Fi update (USB-only):
  - Disponível apenas quando o dashboard estiver rodando na máquina local
    conectada fisicamente ao ESP32 via USB.
  - Fluxo:
    1. Usuário preenche SSID e senha no painel "wifi setup (usb only)".
    2. Dashboard lista portas seriais e escolhe a mais provável (ou a
       selecionada manualmente) e envia uma string serial formatada:
       `WIFI_CONFIG|<ssid>|<password>\n`.
    3. ESP32 responde via Serial com `WIFI_CONFIG_OK|ssid=<ssid>` em caso
       de sucesso, ou `WIFI_CONFIG_ERR|<motivo>` em caso de erro.
    4. ESP32 grava em NVS e tenta reconectar ao novo Wi‑Fi.
  - Observação: esse fluxo não funciona em hosts remotos (Vercel, Netlify,
    etc.) porque não têm acesso à porta USB do seu hardware.

---

## Caixa impressa em 3D

O modelo da caixa do VITAL (78 × 37 × 35 mm, tampa removível e abertura
para o DHT11) está publicado no Printables, com os arquivos para impressão:

**[VITAL – ESP32 Monitor Enclosure (Temperature & Humidity) no Printables](https://www.printables.com/model/1911580-vital-esp32-monitor-enclosure-temperature-humidity)**

O mesmo modelo é usado na aba 3D view do painel
(`vital-dashboard/public/models/`).

---

## Componentes (hardware)

Os "componentes" deste projeto referem-se aos sensores e periféricos
conectados ao ESP32 que fornecem as leituras exibidas no dashboard.

Ligações (placa ESP32-WROVER-DEV, todos os sensores em 3V3):

| Sensor | Pino do sensor | ESP32 |
|--------|----------------|-------|
| DHT11  | VCC            | 3V3   |
| DHT11  | DATA           | IO4   |
| DHT11  | GND            | GND   |
| LIS3DH | VIN            | 3V3   |
| LIS3DH | SDA            | IO32  |
| LIS3DH | SCL            | IO33  |
| LIS3DH | GND            | GND   |

A câmera OV2640 da placa ocupa IO4 5 18 19 21 22 23 25 26 27 34 35 36 39,
a PSRAM usa IO16/IO17 e a flash IO6–IO11 — por isso o I²C do acelerômetro
fica em IO32/IO33. O DHT11 está no IO4 (linha de dados da câmera, livre
enquanto a câmera não é usada).

- DHT11 (sensor de temperatura e umidade)
  - Função: mede temperatura (°C) e umidade relativa (%).
  - Ligação no projeto: DATA → IO4. O módulo de 3 pinos já tem o pull-up de
    10 kΩ; o sensor "pelado" de 4 pinos (VCC, DATA, NC, GND) precisa de um
    resistor de 4,7–10 kΩ entre DATA e 3V3.
  - Precisão de fábrica: ±2 °C e ±5 %UR.
  - Compensação do calor da placa: o sensor fica perto do ESP32 e lê mais
    quente que o ambiente. O firmware desconta 2,0 °C (padrão) da
    temperatura enviada ao painel e recalcula a umidade relativa para essa
    temperatura (mesma umidade absoluta, fórmula de Magnus). Ajuste sem
    regravar pelo comando serial `COMPENSACAO_TEMP|<°C>` (0 a 10; 0 desliga;
    `COMPENSACAO_TEMP` sozinho consulta). As linhas `D` do modo LOG usadas na
    avaliação continuam com o valor bruto do sensor.
  - Observações: usa a biblioteca "DHT sensor library" (Adafruit). Se o
    DHT11 falhar, o ESP32 continua enviando os dados do acelerômetro.

- LIS3DH (acelerômetro de 3 eixos, I²C)
  - Função: substitui o antigo tilt switch. Mede inclinação real (graus),
    pitch/roll, aceleração por eixo e vibração.
  - Ligação no projeto: SDA → IO32, SCL → IO33, endereço 0x18 ou 0x19
    (detectado automaticamente).
  - Muitos módulos vendidos como "LIS3DH" vêm com o chip **LIS3DSH**
    (WHO_AM_I 0x3F, endereço 0x1D/0x1E). O firmware detecta e suporta os
    dois, e também funciona se SDA/SCL estiverem invertidos (avisa no serial).
  - Configuração: 100 Hz, alta resolução (12 bits), ±2 g; o firmware amostra
    a 50 Hz e separa gravidade (orientação) de vibração com um filtro
    passa-baixa. Driver I²C próprio, sem biblioteca extra.

- Fonte / alimentação
  - Fornecer 5V via USB ou 3.3V regulada conforme o módulo/plataforma usada.
  - Evitar alimentar sensores diretamente de fontes instáveis.

- Interface USB / Serial
  - Função: comunicação com o computador para debug e para a feature
    "wifi setup (usb only)" (envio de SSID/senha via serial).
  - Observações: o comando serial usado pelo dashboard é:
    `WIFI_CONFIG|<ssid>|<password>\n` — o ESP32 responde com
    `WIFI_CONFIG_OK|ssid=<ssid>` ou `WIFI_CONFIG_ERR|<motivo>`.

- ESP32 (módulo)
  - O microcontrolador que integra os sensores, executa o firmware e
    conecta-se ao Wi‑Fi para enviar as leituras ao dashboard.

---

- Firmware ESP32:
  - firmware/vital_esp32/vital_esp32.ino — abre direto no Arduino IDE. Lê
    DHT11 e LIS3DH, publica JSON para /api/reading a cada 3 s e aceita os
    comandos seriais `WIFI_CONFIG|ssid|password`, `CALIBRAR`,
    `LIMIAR_IMPACTO|<g>`, `MODO_ENERGIA|eco|normal` e `COMPENSACAO_TEMP|<°C>`
    (todos salvos em NVS).
    O Wi-Fi reconecta sem bloquear a amostragem do acelerômetro.
  - Antes de gravar, preencha `IP_SERVIDOR` (e `PORTA_SERVIDOR`, padrão
    3000) no topo do arquivo.
  - Gravar com arduino-cli:

```bash
arduino-cli core install esp32:esp32
arduino-cli lib install "DHT sensor library"
arduino-cli compile --fqbn esp32:esp32:esp32wrover firmware/vital_esp32
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32wrover firmware/vital_esp32
```

  - A placa usa conversor USB-serial CH340: no Windows é preciso o driver
    CH340 instalado para a porta COM aparecer.

---

## Abas do painel

- **Overview**: visão geral (temperatura, umidade, orientação, aceleração,
  impactos das últimas 24 h e configuração via USB).
- **3D view**: modelo 3D do VITAL girando conforme a orientação medida pelo
  acelerômetro, ao vivo (10 Hz no modo eco, 20 Hz no normal). Mostra inclinação, pitch e roll, a
  intensidade de movimento e uma seta vermelha na direção de cada impacto.
  - "Level" = orientação em relação ao plano horizontal; "Set 3D zero"
    grava a posição atual como referência (modo "Zeroed").
  - Só o acelerômetro não mede giro em torno do eixo vertical (yaw).
  - Modelo próprio: coloque `vital.glb` (ou `.gltf`, `.stl`, `.obj`) em
    `vital-dashboard/public/models/`. O modelo atual é `vital.stl` (caixa
    de 78 × 37 × 35 mm exportada do Fusion).
  - Alinhamento com o sensor: `public/models/vital.json` (`[0, 90, 0]`,
    medido com o texto VITAL para cima → +X do sensor para cima, e com a
    caixa em pé com o "L" em cima → +Y para cima). Os botões "Align" ajustam
    só no navegador; "Reset" volta para o valor do arquivo. "Load model"
    abre um arquivo só para pré-visualizar.
- **Charts**: temperatura, umidade, orientação e vibração em janelas de
  5 min, 15 min ou 1 h, com eixos, valores ao passar o mouse,
  agora/mín./média/máx., marcas dos impactos e exportação CSV.
- **Impacts**: histórico de colisões com severidade, pico (g), duração,
  eixo dominante, inclinação antes/depois (marca "tipped" se mudou ≥ 30°),
  linha do tempo, filtros, exportação CSV, limpeza e ajuste da sensibilidade.

### Detecção de impactos (firmware)

- O ESP32 calcula a aceleração dinâmica (medida − gravidade, com filtro
  rápido de ~30 ms) a 50 Hz. Acima do limiar (padrão 0,5 g) abre um evento,
  que termina após 150 ms abaixo de metade do limiar.
- Cada evento leva pico, duração, direção e inclinação antes/depois, e vai
  no próximo POST em `eventos`; só sai da fila do ESP32 quando o servidor
  responde 200 (reenvio automático se a rede falhar).
- Severidade: leve < 1,0 g ≤ moderado < 1,5 g ≤ forte (ou saturou ±2 g).
- O histórico fica em `vital-dashboard/data/impactos.json` (até 2000 eventos).
- Sensibilidade: comando serial `LIMIAR_IMPACTO|<g>` (0,1 a 3,0), também
  disponível na aba Impacts com o ESP32 na USB.

### Comunicação

- HTTP POST `/api/reading` a cada 3 s, numa tarefa FreeRTOS separada: a
  leitura do acelerômetro não para mais durante o envio (antes: pausas de
  100–370 ms a cada envio; agora ≤ ~50 ms).
- UDP para a porta **4210** do PC a 10 Hz no modo eco ou 20 Hz no normal
  (`V,seq,ms,gx,gy,gz,dinamica,inclinacao`), repassado ao navegador por
  Server-Sent Events em `/api/stream`. Se o firewall do Windows bloquear UDP,
  a aba 3D cai para o modo "POLLING · 3 s".

### Modo de energia (aquecimento do DHT11)

O DHT11 fica perto do chip do ESP32, então o calor da placa entra na
leitura de temperatura (e faz a umidade relativa parecer menor). Para
esquentar menos, o firmware tem dois modos, trocados pelo comando serial
`MODO_ENERGIA|eco` ou `MODO_ENERGIA|normal` (salvo em NVS; `MODO_ENERGIA`
sozinho só consulta):

| | eco (padrão) | normal (firmware antigo) |
|---|---|---|
| CPU | 80 MHz | 240 MHz |
| Entre as amostras | núcleo dorme (até 5 ms por vez) | loop gira sem parar |
| Stream UDP da aba 3D | 10 Hz | 20 Hz |

Nos dois modos o acelerômetro continua a 50 Hz e o HTTP a cada 3 s. O
modem sleep do Wi-Fi já vem ligado por padrão no ESP32. Para medir o
efeito: `avaliacao\.venv\Scripts\python avaliacao\coletar.py aquecimento
--condicao <nome>` (partida a frio; ver `avaliacao/analisar.py`, Tabela 6).

---

## Rodando localmente

1. Entrar na pasta do dashboard e instalar dependências:

```bash
cd vital-dashboard
npm install
```

2. Rodar em modo dev:

```bash
npm run dev
```

3. Abrir http://localhost:3000

- Para usar a função de trocar Wi‑Fi pelo painel: plugue o ESP32 via USB
  no mesmo computador que está rodando o Next.js e permita acesso à porta
  serial (se necessário).

---