# VITAL

Painel de monitoramento para o seu ESP32 — temperatura, umidade e inclinação,
com visual inspirado na interface da BRIDGES (Death Stranding).

## Rodando o projeto

Você precisa do Node.js instalado (versão 18 ou mais recente).

```bash
npm install
npm run dev
```

Abra `http://localhost:3000` no navegador. O terminal também vai mostrar
o IP da sua máquina na rede local (ou rode `npm run dev -- -H 0.0.0.0` e
descubra o IP com `ipconfig`/`ifconfig`) — é esse IP que o ESP32 vai usar
para enviar os dados, já que ele está em outro dispositivo na sua rede Wi-Fi.

## Como os dados chegam

O ESP32 envia os dados via Wi-Fi com uma requisição HTTP POST para:

```
http://SEU_IP_LOCAL:3000/api/reading
```

Com o corpo em JSON:

```json
{ "temperatura": 24.6, "umidade": 58.2, "motionState": 100, "inclinado": true }
```

O código do ESP32 (`.ino`) que faz esse envio está em anexo separado —
ele lê o DHT e o sensor de inclinação e manda pro dashboard a cada poucos
segundos.

O dashboard atualiza a tela sozinho a cada 3 segundos, puxando os dados
mais recentes do servidor. Se o ESP32 parar de enviar por mais de 15
segundos, o indicador muda para "offline".

## Trocar Wi-Fi do ESP32 pelo dashboard (somente via USB)

Agora existe um painel `wifi setup (usb only)` na tela principal.

- Essa função **só funciona com o ESP32 plugado por cabo USB** no mesmo
  computador que está rodando o Next.js.
- O dashboard envia as novas credenciais pela porta serial e o ESP32 salva
  em memória persistente (NVS), tentando reconectar no Wi-Fi imediatamente.
- Se não houver porta serial detectada, o botão fica desabilitado e a API
  retorna erro informando que o ESP32 precisa estar plugado.

## Estrutura do projeto

```
vital-dashboard/
  app/
    page.js              - a tela do dashboard
    layout.js            - fontes e estrutura raiz
    globals.css          - estilos e a moldura de canto (elemento visual assinatura)
    api/reading/route.js - endpoint que recebe (POST) e serve (GET) os dados
    api/device/wifi/route.js - endpoint USB/serial para trocar credenciais Wi-Fi
  components/
    CornerFrame.js        - a moldura de canto reutilizável
    HistoryChart.js        - gráfico de linha compacto
  lib/
    store.js              - armazenamento em memória das últimas leituras
    serialDevice.js       - integração serial com ESP32 (Wi-Fi e calibração)
```

## Observações

- Os dados ficam guardados em memória — se você reiniciar o servidor
  (`npm run dev`), o histórico zera. Isso é de propósito, para manter o
  projeto simples; se quiser persistência entre reinicializações, dá para
  trocar `lib/store.js` por um arquivo JSON ou um banco tipo SQLite.
- Em produção real (fora da sua rede local), o ESP32 e o servidor Next.js
  precisam estar na mesma rede, ou você precisaria hospedar o dashboard
  em algum lugar acessível pela internet.
