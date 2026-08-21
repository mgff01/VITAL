# VITAL Painel de monitoramento — temperatura, umidade e inclinação.
<img width="1844" height="730" alt="image" src="https://github.com/user-attachments/assets/131fc629-7087-49cc-9e6a-329258efc6c4" />

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
  - Payload JSON esperado:
    - temperatura: number (°C)
    - umidade: number (%)
    - motionState: number (0..100) — escala que representa quão inclinado o
      sensor está (0 = estável, 100 = inclinado)
    - inclinado: boolean (compatibilidade, derived)

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

## Componentes (hardware)

Os "componentes" deste projeto referem-se aos sensores e periféricos
conectados ao ESP32 que fornecem as leituras exibidas no dashboard.

- DHT11 (sensor de temperatura e umidade)
  - Função: mede temperatura (°C) e umidade relativa (%).
  - Ligação no projeto: DATA → GPIO4
  - Observações: o código usa a biblioteca DHT e espera valores numéricos;
    DHT22 é recomendado se precisar de maior precisão.

- Sensor de inclinação (tilt switch)
  - Função: detecta quando o módulo é inclinado; o projeto mapeia esse
    sinal para uma escala visual 0..100 (motionState).
  - Ligação no projeto: sinal digital → GPIO5 (com pull-up interno ativo)
  - Observações: o firmware normaliza polaridade para evitar leituras
    invertidas (há comentário no código sobre isso).

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

- Firmware ESP32 (no repositório raiz):
  - esp32.c++ — código do microcontrolador (ex.: Arduino/PlatformIO) que
    lê DHT, sensor de inclinação, publica JSON para /api/reading e aceita
    comandos seriais `WIFI_CONFIG|ssid|password` para atualizar credenciais
    (salva em NVS). Veja comentários no topo do arquivo para os pinos usados.

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
