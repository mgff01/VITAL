/*
  VITAL — ESP32-WROVER-DEV + DHT11 + LIS3DH -> envia dados via Wi-Fi
  para o dashboard VITAL (projeto Next.js).

  Placa: ESP32-WROVER-DEV (câmera OV2640 na placa).
  A câmera ocupa IO4 5 18 19 21 22 23 25 26 27 34 35 36 39, a PSRAM usa
  IO16/IO17 e a flash IO6–IO11. Por isso os sensores ficam em pinos livres:

  Ligações (ver diagrama do README):
    DHT11  VCC  -> 3V3        LIS3DH VIN -> 3V3
    DHT11  DATA -> IO4        LIS3DH SDA -> IO32
    DHT11  GND  -> GND        LIS3DH SCL -> IO33
                              LIS3DH GND -> GND

  O módulo DHT11 de 3 pinos já tem o pull-up de 10 kΩ. O módulo LIS3DH
  (Adafruit e similares) já tem pull-ups no SDA/SCL.

  O antigo sensor de inclinação digital foi substituído pelo LIS3DH: agora
  motionState (0..100) vem do ângulo real em relação à posição de
  referência, e o payload também leva aceleração, pitch/roll e vibração.

  Comandos seriais (115200, terminados em \n):
    WIFI_CONFIG|<ssid>|<senha>  -> WIFI_CONFIG_OK|ssid=<ssid> | WIFI_CONFIG_ERR|<motivo>
    CALIBRAR                    -> CALIBRAR_OK|x=..,y=..,z=.. | CALIBRAR_ERR|<motivo>
      (grava a posição atual como "0°" de inclinação)
    LIMIAR_IMPACTO|<g>          -> LIMIAR_IMPACTO_OK|<g> | LIMIAR_IMPACTO_ERR|<motivo>
      (sensibilidade da detecção de colisões, 0,1 a 3,0 g; padrão 0,5 g)
    MODO_ENERGIA|eco | MODO_ENERGIA|normal | MODO_ENERGIA
                                -> MODO_ENERGIA_OK|<modo>|<MHz>|<Hz do UDP>
      (eco, o padrão, esquenta menos a placa e o DHT11 que fica perto dela:
       CPU a 80 MHz, processador ocioso entre as amostras e UDP a 10 Hz;
       normal = comportamento antigo: 240 MHz, loop sem pausa e UDP a 20 Hz)
    COMPENSACAO_TEMP|<°C> | COMPENSACAO_TEMP -> COMPENSACAO_TEMP_OK|<°C>
      (quanto descontar da temperatura do DHT11 pelo calor da placa,
       0 a 10 °C, padrão 2,0; a umidade é recalculada junto; 0 desliga)

  Comunicação com o painel:
    - HTTP POST /api/reading a cada 3 s (numa tarefa separada, para não
      travar a leitura do acelerômetro), com os impactos detectados;
    - UDP na porta 4210 (10 Hz no modo eco, 20 Hz no normal) com a
      orientação, para a visualização 3D.
*/

#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <DHT.h>
#include <Preferences.h>
#include <math.h>

// ---- Configurações da rede ----
const char* SSID_WIFI_PADRAO   = "";  // ou configure pelo painel (WIFI_CONFIG via USB)
const char* SENHA_WIFI_PADRAO  = "";
const char* IP_SERVIDOR        = "192.168.15.61"; // IP da máquina rodando o VITAL
const int   PORTA_SERVIDOR     = 3000;

// ---- Pinos (conforme diagrama) ----
#define DHT_PIN   4
#define DHT_TYPE  DHT11
#define I2C_SDA   32
#define I2C_SCL   33
// 100 kHz é mais tolerante a fios longos e a módulos sem pull-up no SDA/SCL
// (nesse caso só sobram os pull-ups internos fracos do ESP32).
#define I2C_FREQ  100000

// ---- Acelerômetro: LIS3DH ou LIS3DSH (detectado automaticamente) ----
// São chips diferentes da ST com nomes parecidos; muitos módulos vendidos
// como "LIS3DH" vêm com LIS3DSH. Os dois têm WHO_AM_I no registrador 0x0F.
// O endereço depende do pino SDO:
//   LIS3DH : 0x18 (SDO em GND) ou 0x19 (SDO em 3V3), WHO_AM_I = 0x33
//   LIS3DSH: 0x1E (SDO em GND) ou 0x1D (SDO em 3V3), WHO_AM_I = 0x3F
struct CandidatoAcelerometro {
  uint8_t endereco;
  uint8_t idEsperado;
  bool lis3dsh;
};
const CandidatoAcelerometro CANDIDATOS_ACEL[] = {
  { 0x18, 0x33, false }, { 0x19, 0x33, false },
  { 0x1D, 0x3F, true  }, { 0x1E, 0x3F, true  },
};
const uint8_t LIS3DH_REG_WHO_AM_I  = 0x0F;

// LIS3DSH: CTRL_REG4 = ODR 100 Hz + BDU + X/Y/Z; CTRL_REG5 = ±2 g, filtro 800 Hz;
// CTRL_REG6 = ADD_INC (auto-incremento do endereço em leituras de vários bytes).
const uint8_t LIS3DSH_REG_CTRL4     = 0x20;
const uint8_t LIS3DSH_REG_CTRL5     = 0x24;
const uint8_t LIS3DSH_REG_CTRL6     = 0x25;
const uint8_t LIS3DSH_CTRL4_100HZ_BDU_XYZ = 0x6F;
const uint8_t LIS3DSH_CTRL5_2G      = 0x00;
const uint8_t LIS3DSH_CTRL6_ADD_INC = 0x10;
// Saída de 16 bits; a ±2 g cada unidade vale 0,06 mg.
const float   LIS3DSH_G_POR_UNIDADE = 0.00006f;

const uint8_t LIS3DH_REG_CTRL1     = 0x20;
const uint8_t LIS3DH_REG_CTRL4     = 0x23;
const uint8_t LIS3DH_REG_OUT_X_L   = 0x28;
const uint8_t LIS3DH_AUTO_INCREMENT = 0x80;
// CTRL1: ODR 100 Hz, eixos X/Y/Z ligados. CTRL4: BDU + alta resolução, ±2 g.
const uint8_t LIS3DH_CTRL1_100HZ_XYZ = 0x57;
const uint8_t LIS3DH_CTRL4_BDU_HR_2G = 0x88;
// Em alta resolução (12 bits) a ±2 g, cada unidade vale 1 mg.
const float   LIS3DH_G_POR_UNIDADE = 0.001f;

// ---- Processamento do acelerômetro ----
const unsigned long INTERVALO_AMOSTRA_MS = 20;    // 50 Hz
const float  ALFA_GRAVIDADE        = 0.1f;        // filtro passa-baixa da orientação
const int    AMOSTRAS_PARA_REFERENCIA = 50;       // ~1 s parado no boot
const float  ANGULO_MAXIMO_GRAUS   = 90.0f;       // 90° = motionState 100
const float  LIMIAR_INCLINADO_GRAUS = 30.0f;
const unsigned long INTERVALO_REINICIO_LIS3DH_MS = 5000;

// ---- Envio / Wi-Fi ----
const unsigned long INTERVALO_ENVIO_MS = 3000;
const unsigned long INTERVALO_RECONEXAO_MS = 10000;
const uint16_t TIMEOUT_HTTP_MS = 2000;

// ---- Stream em tempo real (visualização 3D do painel) ----
// Manda por UDP: V,<seq>,<ms>,<gx>,<gy>,<gz>,<dinamica_max_g>,<inclinacao>
const uint16_t PORTA_UDP = 4210;
const unsigned long INTERVALO_UDP_NORMAL_MS = 50;   // 20 Hz
const unsigned long INTERVALO_UDP_ECO_MS = 100;     // 10 Hz

// ---- Modo de energia (aquecimento da placa) ----
// O DHT11 fica perto do ESP32, então o calor da placa entra na leitura.
// No modo eco a CPU roda a 80 MHz e dorme entre as amostras (a tarefa ociosa
// do FreeRTOS desliga o clock do núcleo), e o rádio acorda metade das vezes.
const uint32_t CPU_MHZ_NORMAL = 240;
const uint32_t CPU_MHZ_ECO = 80;
const unsigned long PAUSA_MAX_ECO_MS = 5;  // mantém os comandos seriais responsivos
bool modoEco = true;
unsigned long intervaloUdpMs = INTERVALO_UDP_ECO_MS;

// ---- Detecção de impactos / colisões ----
// Aceleração dinâmica = aceleração medida - gravidade estimada por um filtro
// rápido (α = 0,5, ~30 ms), para que rotações lentas não virem "impacto".
const float ALFA_GRAVIDADE_RAPIDA = 0.5f;
const float LIMIAR_IMPACTO_PADRAO_G = 0.5f;
const float LIMIAR_IMPACTO_MIN_G = 0.1f;
const float LIMIAR_IMPACTO_MAX_G = 3.0f;
const unsigned long IMPACTO_SILENCIO_MS = 150;      // abaixo de metade do limiar por 150 ms = fim
const unsigned long IMPACTO_DURACAO_MAX_MS = 2000;
const unsigned long IMPACTO_ASSENTAMENTO_MS = 1000; // espera para medir a inclinação depois
const unsigned long IMPACTO_INTERVALO_MIN_MS = 300;
const float LIMITE_SATURACAO_G = 1.95f;             // faixa de ±2 g
const int MAX_EVENTOS_PENDENTES = 8;

// ---- Compensação do calor da placa no DHT11 ----
// O DHT11 fica perto do ESP32 e lê mais quente que o ambiente. O painel
// recebe a temperatura lida menos compensacaoTemp, e a umidade relativa
// recalculada para essa temperatura (mesma umidade absoluta, fórmula de
// Magnus). As linhas D do modo LOG continuam com o valor bruto do sensor.
const float COMPENSACAO_TEMP_PADRAO_C = 2.0f;
const float COMPENSACAO_TEMP_MAX_C = 10.0f;
float compensacaoTemp = COMPENSACAO_TEMP_PADRAO_C;

DHT dht(DHT_PIN, DHT_TYPE);
Preferences preferencias;

String ssidAtual = SSID_WIFI_PADRAO;
String senhaAtual = SENHA_WIFI_PADRAO;
String bufferSerial = "";

struct Vetor3 {
  float x;
  float y;
  float z;
};

// Estado do LIS3DH
uint8_t enderecoLis3dh = 0;
bool ehLis3dsh = false;   // true quando o chip encontrado é um LIS3DSH
bool lis3dhOk = false;
unsigned long ultimaTentativaLis3dh = 0;

Vetor3 aceleracaoAtual = { 0, 0, 0 };
Vetor3 gravidade = { 0, 0, 0 };
Vetor3 referencia = { 0, 0, 1 };
bool gravidadeIniciada = false;
bool referenciaValida = false;
int amostrasDesdeInicio = 0;

// Vibração acumulada na janela entre dois envios
float somaQuadradosDinamica = 0;
float picoDinamica = 0;
int amostrasNaJanela = 0;

unsigned long ultimaAmostra = 0;
unsigned long ultimoEnvio = 0;
unsigned long ultimaTentativaWiFi = 0;
bool estavaConectado = false;

// ---- Modo de avaliação (coleta de dados para o artigo; ver pasta avaliacao/) ----
// LOG_ON / LOG_OFF        -> imprime linhas CSV com prefixo:
//   R,<ms>,<ax>,<ay>,<az>            aceleração bruta (g) a cada amostra (50 Hz)
//   D,<ms>,<temp>,<umid>,<ok>        leitura do DHT11 a cada envio
//   H,<ms>,<seq>,<lat_ms>,<codigo>,<modo>  resultado de cada envio HTTP
// MODO_HTTP|novo           -> abre uma conexão TCP nova a cada envio (padrão)
// MODO_HTTP|reuso          -> mantém a conexão aberta (HTTP keep-alive)
// BENCH                    -> mede no ESP32 o custo de cada método de filtragem
bool modoLog = false;
volatile bool httpReuso = false;
uint32_t sequenciaEnvio = 0;
WiFiClient clienteTcpPersistente;
HTTPClient httpPersistente;

// ---- Envio HTTP numa tarefa separada (núcleo 0) ----
// Assim o loop continua amostrando o acelerômetro enquanto o POST espera a rede.
struct PedidoHttp {
  String corpo;
  uint32_t seq;
  uint8_t nEventos;
  bool reuso;
};
struct RespostaHttp {
  uint32_t seq;
  int codigo;
  float latenciaMs;
  uint8_t nEventos;
  bool reuso;
  char erro[48];
};
QueueHandle_t filaPedidosHttp = nullptr;
QueueHandle_t filaRespostasHttp = nullptr;
volatile bool envioEmAndamento = false;

// ---- Stream UDP ----
WiFiUDP udp;
uint32_t sequenciaUdp = 0;
unsigned long ultimoUdp = 0;
float picoDinamicaUdp = 0;

// ---- Impactos ----
struct EventoImpacto {
  uint32_t inicioMs;
  uint16_t duracaoMs;
  float picoG;
  float dx, dy, dz;      // direção da aceleração no pico (g)
  float inclAntes, inclDepois;
  bool saturado;
};
enum EstadoImpacto { IMPACTO_OCIOSO, IMPACTO_ATIVO, IMPACTO_ASSENTANDO };
EstadoImpacto estadoImpacto = IMPACTO_OCIOSO;
EventoImpacto impactoAtual;
EventoImpacto eventosPendentes[MAX_EVENTOS_PENDENTES];
int nEventosPendentes = 0;
uint32_t eventosDescartados = 0;
float limiarImpacto = LIMIAR_IMPACTO_PADRAO_G;
unsigned long ultimoAcimaMs = 0;
unsigned long fimImpactoMs = 0;
float inclinacaoEstavel = NAN;
Vetor3 gravidadeRapida = { 0, 0, 0 };
uint32_t idBoot = 0;   // distingue eventos de reinicializações diferentes

void conectarWiFi();
void manterWiFi();
void lerComandosSerial();
void processarComandoSerial(String linha);
void aplicarCredenciaisWiFi(const String& novoSSID, const String& novaSenha);
void carregarCredenciaisWiFi();
void salvarCredenciaisWiFi(const String& novoSSID, const String& novaSenha);
bool iniciarLis3dh();
bool lerAceleracao(Vetor3& saida);
void amostrarAcelerometro();
void calibrarReferencia();
void diagnosticarBarramentoI2C();
void carregarReferencia();
float calcularInclinacao();
void lerEEnviar();
void executarBenchmark();
void tarefaHttp(void* parametro);
void processarRespostasHttp();
void enviarAmostraUdp();
void detectarImpacto(const Vetor3& a, float dyn, float dx, float dy, float dz);
void carregarLimiarImpacto();
void ajustarLimiarImpacto(const String& texto);
void carregarModoEnergia();
void aplicarModoEnergia();
void ajustarModoEnergia(const String& texto);
void carregarCompensacao();
void ajustarCompensacao(const String& texto);
void compensarLeitura(float& temperatura, float& umidade);

// ---------------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nVITAL — ESP32-WROVER + DHT11 + LIS3DH");
  carregarModoEnergia();
  aplicarModoEnergia();

  dht.begin();
  idBoot = esp_random();
  carregarLimiarImpacto();
  carregarCompensacao();

  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  carregarReferencia();
  if (!iniciarLis3dh()) {
    Serial.println("LIS3DH não encontrado. Vou tentar de novo a cada 5 s.");
  }

  filaPedidosHttp = xQueueCreate(1, sizeof(PedidoHttp*));
  filaRespostasHttp = xQueueCreate(4, sizeof(RespostaHttp));
  xTaskCreatePinnedToCore(tarefaHttp, "http", 8192, nullptr, 1, nullptr, 0);

  carregarCredenciaisWiFi();
  conectarWiFi();
}

void loop() {
  lerComandosSerial();
  manterWiFi();
  processarRespostasHttp();

  unsigned long agora = millis();

  if (agora - ultimaAmostra >= INTERVALO_AMOSTRA_MS) {
    // grade fixa de 20 ms (50 Hz exatos em média); se atrasar mais de uma
    // amostra (leitura do DHT, BENCH), recomeça a grade a partir de agora
    ultimaAmostra += INTERVALO_AMOSTRA_MS;
    if (agora - ultimaAmostra >= INTERVALO_AMOSTRA_MS) {
      ultimaAmostra = agora;
    }
    amostrarAcelerometro();
  }

  if (agora - ultimoUdp >= intervaloUdpMs) {
    ultimoUdp = agora;
    enviarAmostraUdp();
  }

  if (agora - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = agora;
    lerEEnviar();
  }

  if (modoEco) {
    // dorme até a próxima amostra (no máximo 5 ms): o núcleo fica ocioso
    // em vez de girar no loop, o que reduz o consumo e o calor da placa
    unsigned long depois = millis();
    long espera = (long)(ultimaAmostra + INTERVALO_AMOSTRA_MS - depois);
    long esperaUdp = (long)(ultimoUdp + intervaloUdpMs - depois);
    if (esperaUdp < espera) espera = esperaUdp;
    if (espera > (long)PAUSA_MAX_ECO_MS) espera = PAUSA_MAX_ECO_MS;
    if (espera > 0) delay(espera);
  }
}

// ---------------------------------------------------------------------------
// Wi-Fi (não bloqueante, para o acelerômetro continuar amostrando)
// ---------------------------------------------------------------------------

void carregarCredenciaisWiFi() {
  preferencias.begin("vital", true);
  String ssidSalvo = preferencias.getString("ssid", "");
  String senhaSalva = preferencias.getString("senha", "");
  preferencias.end();

  if (ssidSalvo.length() > 0) {
    ssidAtual = ssidSalvo;
  }
  if (senhaSalva.length() > 0) {
    senhaAtual = senhaSalva;
  }
}

void salvarCredenciaisWiFi(const String& novoSSID, const String& novaSenha) {
  preferencias.begin("vital", false);
  preferencias.putString("ssid", novoSSID);
  preferencias.putString("senha", novaSenha);
  preferencias.end();
}

void conectarWiFi() {
  ultimaTentativaWiFi = millis();

  if (ssidAtual.length() == 0) {
    Serial.println("Wi-Fi sem SSID. Configure pelo painel (WIFI_CONFIG via USB).");
    return;
  }

  Serial.printf("Conectando na rede %s...\n", ssidAtual.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssidAtual.c_str(), senhaAtual.c_str());
}

void manterWiFi() {
  bool conectado = WiFi.status() == WL_CONNECTED;

  if (conectado && !estavaConectado) {
    Serial.print("Conectado! IP do ESP32: ");
    Serial.println(WiFi.localIP());
  } else if (!conectado && estavaConectado) {
    Serial.println("Wi-Fi caiu, tentando reconectar...");
  }
  estavaConectado = conectado;

  if (!conectado && millis() - ultimaTentativaWiFi >= INTERVALO_RECONEXAO_MS) {
    WiFi.disconnect();
    conectarWiFi();
  }
}

void aplicarCredenciaisWiFi(const String& novoSSID, const String& novaSenha) {
  if (novoSSID.length() == 0) {
    Serial.println("WIFI_CONFIG_ERR|ssid_vazio");
    return;
  }

  ssidAtual = novoSSID;
  senhaAtual = novaSenha;
  salvarCredenciaisWiFi(ssidAtual, senhaAtual);

  Serial.printf("WIFI_CONFIG_OK|ssid=%s\n", ssidAtual.c_str());

  WiFi.disconnect(true);
  delay(100);
  estavaConectado = false;
  conectarWiFi();
}

// ---------------------------------------------------------------------------
// Comandos seriais
// ---------------------------------------------------------------------------

void processarComandoSerial(String linha) {
  linha.trim();
  if (linha.length() == 0) {
    return;
  }

  if (linha == "CALIBRAR") {
    calibrarReferencia();
    return;
  }

  if (linha == "LOG_ON" || linha == "LOG_OFF") {
    modoLog = (linha == "LOG_ON");
    Serial.printf("LOG_OK|%s\n", modoLog ? "on" : "off");
    return;
  }

  if (linha == "MODO_HTTP|novo" || linha == "MODO_HTTP|reuso") {
    // a tarefa HTTP fecha a conexão persistente no próximo envio em modo "novo"
    httpReuso = linha.endsWith("reuso");
    Serial.printf("MODO_HTTP_OK|%s\n", httpReuso ? "reuso" : "novo");
    return;
  }

  if (linha.startsWith("LIMIAR_IMPACTO|")) {
    ajustarLimiarImpacto(linha.substring(15));
    return;
  }

  if (linha == "BENCH") {
    executarBenchmark();
    return;
  }

  if (linha == "MODO_ENERGIA" || linha.startsWith("MODO_ENERGIA|")) {
    ajustarModoEnergia(linha.length() > 13 ? linha.substring(13) : String(""));
    return;
  }

  if (linha == "COMPENSACAO_TEMP" || linha.startsWith("COMPENSACAO_TEMP|")) {
    ajustarCompensacao(linha.length() > 17 ? linha.substring(17) : String(""));
    return;
  }

  if (!linha.startsWith("WIFI_CONFIG|")) {
    Serial.println("CMD_ERR|comando_desconhecido");
    return;
  }

  int primeiroSeparador = linha.indexOf('|');
  int segundoSeparador = linha.indexOf('|', primeiroSeparador + 1);

  if (segundoSeparador < 0) {
    Serial.println("WIFI_CONFIG_ERR|formato_invalido");
    return;
  }

  String novoSSID = linha.substring(primeiroSeparador + 1, segundoSeparador);
  String novaSenha = linha.substring(segundoSeparador + 1);
  novoSSID.trim();

  aplicarCredenciaisWiFi(novoSSID, novaSenha);
}

void lerComandosSerial() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());

    if (c == '\n' || c == '\r') {
      if (bufferSerial.length() > 0) {
        processarComandoSerial(bufferSerial);
        bufferSerial = "";
      }
      continue;
    }

    if (bufferSerial.length() < 255) {
      bufferSerial += c;
    }
  }
}

// ---------------------------------------------------------------------------
// LIS3DH (I²C direto, sem biblioteca extra)
// ---------------------------------------------------------------------------

bool escreverRegistroLis3dh(uint8_t registro, uint8_t valor) {
  Wire.beginTransmission(enderecoLis3dh);
  Wire.write(registro);
  Wire.write(valor);
  return Wire.endTransmission() == 0;
}

bool lerRegistrosLis3dh(uint8_t endereco, uint8_t registro, uint8_t* destino, size_t quantidade) {
  Wire.beginTransmission(endereco);
  // No LIS3DH o auto-incremento é o bit 7 do endereço; no LIS3DSH é o ADD_INC do CTRL_REG6.
  bool autoIncrementoNoEndereco = quantidade > 1 && !ehLis3dsh;
  Wire.write(autoIncrementoNoEndereco ? (registro | LIS3DH_AUTO_INCREMENT) : registro);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  if (Wire.requestFrom((uint16_t)endereco, quantidade, true) != quantidade) {
    return false;
  }

  for (size_t i = 0; i < quantidade; i++) {
    destino[i] = Wire.read();
  }
  return true;
}

// Ninguém respondeu em 0x18/0x19: verifica se os pull-ups do módulo chegam
// em SDA/SCL. Sem pull-up externo, o módulo provavelmente está sem energia
// ou os fios não estão nesses pinos.
void diagnosticarBarramentoI2C() {
  Wire.end();
  pinMode(I2C_SDA, INPUT_PULLDOWN);
  pinMode(I2C_SCL, INPUT_PULLDOWN);
  delay(2);
  int sda = digitalRead(I2C_SDA);
  int scl = digitalRead(I2C_SCL);
  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);

  Serial.printf("Acelerômetro não respondeu (LIS3DH 0x18/0x19, LIS3DSH 0x1D/0x1E; SDA=IO%d, SCL=IO%d). Pull-up externo: SDA=%s SCL=%s\n",
                I2C_SDA, I2C_SCL, sda ? "sim" : "NÃO", scl ? "sim" : "NÃO");
  if (!sda || !scl) {
    Serial.println("  -> Sem pull-up: módulo sem energia (VCC/GND), pinos do módulo sem solda/mau contato,");
    Serial.println("     ou SDA/SCL ligados em outros pinos. Confira também CS em 3V3 (senão o chip fica em modo SPI).");
  } else {
    Serial.println("  -> Pull-ups OK mas sem resposta: confira o pino CS do módulo em 3V3 e se SDA/SCL não estão invertidos.");
  }
}

// Procura um LIS3DH ou LIS3DSH no barramento já iniciado.
bool procurarLis3dhNoBarramento(int sda, int scl, bool& algumRespondeu) {
  for (const CandidatoAcelerometro& c : CANDIDATOS_ACEL) {
    uint8_t id = 0;
    if (!lerRegistrosLis3dh(c.endereco, LIS3DH_REG_WHO_AM_I, &id, 1)) {
      continue;
    }
    algumRespondeu = true;
    if (id == c.idEsperado) {
      enderecoLis3dh = c.endereco;
      ehLis3dsh = c.lis3dsh;
      return true;
    }
    Serial.printf("SDA=IO%d SCL=IO%d: dispositivo em 0x%02X respondeu WHO_AM_I=0x%02X (esperado 0x%02X).\n",
                  sda, scl, c.endereco, id, c.idEsperado);
  }
  return false;
}

// Lista qualquer dispositivo I²C que responda (ajuda a ver se o módulo é outro chip).
void listarDispositivosI2C(int sda, int scl) {
  String achados = "";
  for (uint8_t a = 0x08; a < 0x78; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      char buf[8];
      snprintf(buf, sizeof(buf), " 0x%02X", a);
      achados += buf;
    }
  }
  Serial.printf("  Scan I2C (SDA=IO%d SCL=IO%d):%s\n", sda, scl,
                achados.length() ? achados.c_str() : " nenhum dispositivo");
}

bool iniciarLis3dh() {
  ultimaTentativaLis3dh = millis();
  lis3dhOk = false;
  enderecoLis3dh = 0;
  ehLis3dsh = false;

  // Tenta a ligação do diagrama e, se falhar, SDA/SCL invertidos.
  const int pares[2][2] = { { I2C_SDA, I2C_SCL }, { I2C_SCL, I2C_SDA } };
  bool algumRespondeu = false;
  bool achou = false;
  for (auto& par : pares) {
    Wire.end();
    Wire.begin(par[0], par[1], I2C_FREQ);
    if (procurarLis3dhNoBarramento(par[0], par[1], algumRespondeu)) {
      achou = true;
      if (par[0] != I2C_SDA) {
        Serial.printf("Atenção: acelerômetro achado com SDA/SCL INVERTIDOS (SDA=IO%d, SCL=IO%d). "
                      "Funciona assim, mas o ideal é trocar os dois fios.\n", par[0], par[1]);
      }
      break;
    }
    listarDispositivosI2C(par[0], par[1]);
  }

  if (!achou) {
    if (!algumRespondeu) {
      diagnosticarBarramentoI2C();
    }
    return false;
  }

  bool configurado;
  if (ehLis3dsh) {
    configurado = escreverRegistroLis3dh(LIS3DSH_REG_CTRL6, LIS3DSH_CTRL6_ADD_INC) &&
                  escreverRegistroLis3dh(LIS3DSH_REG_CTRL5, LIS3DSH_CTRL5_2G) &&
                  escreverRegistroLis3dh(LIS3DSH_REG_CTRL4, LIS3DSH_CTRL4_100HZ_BDU_XYZ);
  } else {
    configurado = escreverRegistroLis3dh(LIS3DH_REG_CTRL1, LIS3DH_CTRL1_100HZ_XYZ) &&
                  escreverRegistroLis3dh(LIS3DH_REG_CTRL4, LIS3DH_CTRL4_BDU_HR_2G);
  }
  if (!configurado) {
    enderecoLis3dh = 0;
    return false;
  }

  delay(20); // primeira amostra válida a 100 Hz
  gravidadeIniciada = false;
  amostrasDesdeInicio = 0;
  lis3dhOk = true;
  Serial.printf("%s OK no endereço 0x%02X\n", ehLis3dsh ? "LIS3DSH" : "LIS3DH", enderecoLis3dh);
  return true;
}

bool lerAceleracao(Vetor3& saida) {
  uint8_t bruto[6];
  if (!lerRegistrosLis3dh(enderecoLis3dh, LIS3DH_REG_OUT_X_L, bruto, sizeof(bruto))) {
    return false;
  }

  int16_t x = (int16_t)((bruto[1] << 8) | bruto[0]);
  int16_t y = (int16_t)((bruto[3] << 8) | bruto[2]);
  int16_t z = (int16_t)((bruto[5] << 8) | bruto[4]);

  if (ehLis3dsh) {
    // LIS3DSH: 16 bits completos.
    saida.x = x * LIS3DSH_G_POR_UNIDADE;
    saida.y = y * LIS3DSH_G_POR_UNIDADE;
    saida.z = z * LIS3DSH_G_POR_UNIDADE;
  } else {
    // LIS3DH: alinhado à esquerda em 16 bits; em alta resolução valem 12 bits.
    saida.x = (x >> 4) * LIS3DH_G_POR_UNIDADE;
    saida.y = (y >> 4) * LIS3DH_G_POR_UNIDADE;
    saida.z = (z >> 4) * LIS3DH_G_POR_UNIDADE;
  }
  return true;
}

void amostrarAcelerometro() {
  if (!lis3dhOk) {
    if (millis() - ultimaTentativaLis3dh >= INTERVALO_REINICIO_LIS3DH_MS) {
      enderecoLis3dh = 0;
      iniciarLis3dh();
    }
    return;
  }

  Vetor3 a;
  if (!lerAceleracao(a)) {
    Serial.println("Erro: falha ao ler o LIS3DH. Vou tentar reiniciar o sensor.");
    lis3dhOk = false;
    return;
  }
  aceleracaoAtual = a;

  if (modoLog) {
    Serial.printf("R,%lu,%.5f,%.5f,%.5f\n", millis(), a.x, a.y, a.z);
  }

  // Passa-baixa: separa a gravidade (orientação) da parte dinâmica (vibração).
  if (!gravidadeIniciada) {
    gravidade = a;
    gravidadeRapida = a;
    gravidadeIniciada = true;
  } else {
    gravidade.x += ALFA_GRAVIDADE * (a.x - gravidade.x);
    gravidade.y += ALFA_GRAVIDADE * (a.y - gravidade.y);
    gravidade.z += ALFA_GRAVIDADE * (a.z - gravidade.z);
  }

  float dx = a.x - gravidade.x;
  float dy = a.y - gravidade.y;
  float dz = a.z - gravidade.z;
  float modulo2 = dx * dx + dy * dy + dz * dz;
  somaQuadradosDinamica += modulo2;
  picoDinamica = max(picoDinamica, sqrtf(modulo2));
  amostrasNaJanela++;

  // Impactos: filtro rápido da gravidade, para pegar só o que é brusco.
  float rx = a.x - gravidadeRapida.x;
  float ry = a.y - gravidadeRapida.y;
  float rz = a.z - gravidadeRapida.z;
  float dinamicaRapida = sqrtf(rx * rx + ry * ry + rz * rz);
  gravidadeRapida.x += ALFA_GRAVIDADE_RAPIDA * (a.x - gravidadeRapida.x);
  gravidadeRapida.y += ALFA_GRAVIDADE_RAPIDA * (a.y - gravidadeRapida.y);
  gravidadeRapida.z += ALFA_GRAVIDADE_RAPIDA * (a.z - gravidadeRapida.z);
  picoDinamicaUdp = max(picoDinamicaUdp, dinamicaRapida);
  detectarImpacto(a, dinamicaRapida, rx, ry, rz);

  // Sem referência salva em NVS, usa a posição em que a placa ligou.
  if (!referenciaValida && ++amostrasDesdeInicio >= AMOSTRAS_PARA_REFERENCIA) {
    referencia = gravidade;
    referenciaValida = true;
    Serial.println("Referência de inclinação definida pela posição atual (boot).");
  }
}

void carregarReferencia() {
  preferencias.begin("vital", true);
  bool salva = preferencias.getBool("refOk", false);
  if (salva) {
    referencia.x = preferencias.getFloat("refX", 0);
    referencia.y = preferencias.getFloat("refY", 0);
    referencia.z = preferencias.getFloat("refZ", 1);
  }
  preferencias.end();
  referenciaValida = salva;
}

void calibrarReferencia() {
  if (!lis3dhOk || !gravidadeIniciada) {
    Serial.println("CALIBRAR_ERR|lis3dh_indisponivel");
    return;
  }

  referencia = gravidade;
  referenciaValida = true;

  preferencias.begin("vital", false);
  preferencias.putFloat("refX", referencia.x);
  preferencias.putFloat("refY", referencia.y);
  preferencias.putFloat("refZ", referencia.z);
  preferencias.putBool("refOk", true);
  preferencias.end();

  Serial.printf("CALIBRAR_OK|x=%.3f,y=%.3f,z=%.3f\n", referencia.x, referencia.y, referencia.z);
}

float calcularInclinacao() {
  // Ângulo entre a gravidade atual e a gravidade na posição de referência.
  float produto = gravidade.x * referencia.x + gravidade.y * referencia.y + gravidade.z * referencia.z;
  float moduloAtual = sqrtf(gravidade.x * gravidade.x + gravidade.y * gravidade.y + gravidade.z * gravidade.z);
  float moduloRef = sqrtf(referencia.x * referencia.x + referencia.y * referencia.y + referencia.z * referencia.z);

  if (moduloAtual < 0.1f || moduloRef < 0.1f) {
    return NAN; // queda livre ou leitura inválida
  }

  float cosseno = constrain(produto / (moduloAtual * moduloRef), -1.0f, 1.0f);
  return acosf(cosseno) * RAD_TO_DEG;
}

// ---------------------------------------------------------------------------
// Leitura + envio
// ---------------------------------------------------------------------------

// Acrescenta "chave":valor ao JSON, ou "chave":null quando o valor é inválido.
void adicionarCampo(String& json, const char* chave, float valor, int casas) {
  if (json.length() > 1) {
    json += ",";
  }
  json += "\"";
  json += chave;
  json += "\":";
  json += isnan(valor) ? String("null") : String(valor, casas);
}

void adicionarCampoBool(String& json, const char* chave, bool valor) {
  if (json.length() > 1) {
    json += ",";
  }
  json += "\"";
  json += chave;
  json += "\":";
  json += valor ? "true" : "false";
}

void lerEEnviar() {
  float temperatura = dht.readTemperature();
  float umidade = dht.readHumidity();
  bool dhtOk = !isnan(temperatura) && !isnan(umidade);
  if (!dhtOk) {
    Serial.printf("Aviso: falha ao ler o DHT11 (IO%d). Enviando só o acelerômetro.\n", DHT_PIN);
  }
  if (modoLog) {
    Serial.printf("D,%lu,%.1f,%.1f,%d\n", millis(), temperatura, umidade, dhtOk ? 1 : 0);  // bruto
  }
  float temperaturaSensor = temperatura;
  compensarLeitura(temperatura, umidade);

  bool acelOk = lis3dhOk && gravidadeIniciada;
  float inclinacao = acelOk ? calcularInclinacao() : NAN;
  float motionState = isnan(inclinacao) ? NAN : constrain(inclinacao / ANGULO_MAXIMO_GRAUS * 100.0f, 0.0f, 100.0f);
  bool inclinado = !isnan(inclinacao) && inclinacao >= LIMIAR_INCLINADO_GRAUS;

  float pitch = NAN, roll = NAN, vibracao = NAN, pico = NAN;
  if (acelOk) {
    pitch = atan2f(-gravidade.x, sqrtf(gravidade.y * gravidade.y + gravidade.z * gravidade.z)) * RAD_TO_DEG;
    roll = atan2f(gravidade.y, gravidade.z) * RAD_TO_DEG;
    if (amostrasNaJanela > 0) {
      vibracao = sqrtf(somaQuadradosDinamica / amostrasNaJanela);
      pico = picoDinamica;
    }
  }
  somaQuadradosDinamica = 0;
  picoDinamica = 0;
  amostrasNaJanela = 0;

  if (!dhtOk && !acelOk) {
    Serial.println("Erro: nenhum sensor respondeu. Pulando este envio.");
    return;
  }

  Serial.printf(
    "Temp: %.1fC (sensor %.1fC)  Umidade: %.1f%%  Inclinação: %.1f°  Pitch: %.1f°  Roll: %.1f°  Vibração: %.3fg  MotionState: %.0f\n",
    temperatura, temperaturaSensor, umidade, inclinacao, pitch, roll, vibracao, motionState
  );

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Sem Wi-Fi, não foi possível enviar.");
    if (modoLog) {
      // conta como envio perdido na taxa de entrega
      Serial.printf("H,%lu,%lu,%.3f,%d,%s\n", millis(), (unsigned long)++sequenciaEnvio, 0.0f, -100,
                    httpReuso ? "reuso" : "novo");
    }
    return;
  }

  if (strlen(IP_SERVIDOR) == 0) {
    Serial.println("IP_SERVIDOR vazio: defina o IP da máquina do dashboard no topo do código.");
    return;
  }

  String corpo = "{";
  adicionarCampo(corpo, "temperatura", temperatura, 1);
  adicionarCampo(corpo, "umidade", umidade, 1);
  adicionarCampo(corpo, "motionState", motionState, 0);
  adicionarCampoBool(corpo, "inclinado", inclinado);
  adicionarCampo(corpo, "inclinacao", inclinacao, 1);
  adicionarCampo(corpo, "pitch", pitch, 1);
  adicionarCampo(corpo, "roll", roll, 1);
  adicionarCampo(corpo, "ax", acelOk ? aceleracaoAtual.x : NAN, 3);
  adicionarCampo(corpo, "ay", acelOk ? aceleracaoAtual.y : NAN, 3);
  adicionarCampo(corpo, "az", acelOk ? aceleracaoAtual.z : NAN, 3);
  adicionarCampo(corpo, "vibracao", vibracao, 3);
  adicionarCampo(corpo, "pico", pico, 3);
  adicionarCampoBool(corpo, "dhtOk", dhtOk);
  adicionarCampoBool(corpo, "acelerometroOk", acelOk);
  adicionarCampo(corpo, "limiarImpacto", limiarImpacto, 2);
  corpo += ",\"ms\":";
  corpo += String(millis());

  // Impactos ainda não confirmados pelo servidor (reenviados até chegar 200).
  int nEventos = nEventosPendentes;
  corpo += ",\"eventos\":[";
  for (int i = 0; i < nEventos; i++) {
    const EventoImpacto& e = eventosPendentes[i];
    char id[24];
    snprintf(id, sizeof(id), "%08lx-%lu", (unsigned long)idBoot, (unsigned long)e.inicioMs);
    if (i > 0) corpo += ",";
    corpo += "{\"id\":\"";
    corpo += id;
    corpo += "\",\"ms\":";
    corpo += String((unsigned long)e.inicioMs);
    corpo += ",\"duracaoMs\":";
    corpo += String((unsigned)e.duracaoMs);
    adicionarCampo(corpo, "picoG", e.picoG, 3);
    adicionarCampo(corpo, "dx", e.dx, 3);
    adicionarCampo(corpo, "dy", e.dy, 3);
    adicionarCampo(corpo, "dz", e.dz, 3);
    adicionarCampo(corpo, "inclAntes", e.inclAntes, 1);
    adicionarCampo(corpo, "inclDepois", e.inclDepois, 1);
    adicionarCampoBool(corpo, "saturado", e.saturado);
    corpo += "}";
  }
  corpo += "]}";

  sequenciaEnvio++;
  if (envioEmAndamento) {
    // O POST anterior ainda não terminou (rede lenta): descarta este ciclo.
    Serial.println("Envio anterior ainda em andamento, pulando este ciclo.");
    if (modoLog) {
      Serial.printf("H,%lu,%lu,%.3f,%d,%s\n", millis(), (unsigned long)sequenciaEnvio, 0.0f, -101,
                    httpReuso ? "reuso" : "novo");
    }
    return;
  }

  PedidoHttp* pedido = new PedidoHttp{ corpo, sequenciaEnvio, (uint8_t)nEventos, httpReuso };
  envioEmAndamento = true;
  if (xQueueSend(filaPedidosHttp, &pedido, 0) != pdTRUE) {
    delete pedido;
    envioEmAndamento = false;
  }
}

// ---------------------------------------------------------------------------
// Tarefa HTTP (roda no núcleo 0; o loop continua no núcleo 1)
// ---------------------------------------------------------------------------

void tarefaHttp(void* parametro) {
  for (;;) {
    PedidoHttp* p = nullptr;
    if (xQueueReceive(filaPedidosHttp, &p, portMAX_DELAY) != pdTRUE || p == nullptr) {
      continue;
    }

    RespostaHttp r = {};
    r.seq = p->seq;
    r.nEventos = p->nEventos;
    r.reuso = p->reuso;

    String url = String("http://") + IP_SERVIDOR + ":" + PORTA_SERVIDOR + "/api/reading";
    String textoErro;
    unsigned long inicioUs = micros();

    if (p->reuso) {
      // Conexão persistente: o mesmo socket TCP é reaproveitado entre envios.
      httpPersistente.setReuse(true);
      httpPersistente.setConnectTimeout(TIMEOUT_HTTP_MS);
      httpPersistente.setTimeout(TIMEOUT_HTTP_MS);
      httpPersistente.begin(clienteTcpPersistente, url);
      httpPersistente.addHeader("Content-Type", "application/json");
      r.codigo = httpPersistente.POST(p->corpo);
      if (r.codigo <= 0) {
        textoErro = httpPersistente.errorToString(r.codigo);
      }
      httpPersistente.end();
    } else {
      if (clienteTcpPersistente.connected()) {
        clienteTcpPersistente.stop();  // saiu do modo "reuso"
      }
      // Padrão do VITAL: uma conexão TCP nova a cada envio.
      HTTPClient http;
      http.setReuse(false);
      http.setConnectTimeout(TIMEOUT_HTTP_MS);
      http.setTimeout(TIMEOUT_HTTP_MS);
      http.begin(url);
      http.addHeader("Content-Type", "application/json");
      r.codigo = http.POST(p->corpo);
      if (r.codigo <= 0) {
        textoErro = http.errorToString(r.codigo);
      }
      http.end();
    }
    r.latenciaMs = (micros() - inicioUs) / 1000.0f;
    strncpy(r.erro, textoErro.c_str(), sizeof(r.erro) - 1);

    delete p;
    xQueueSend(filaRespostasHttp, &r, portMAX_DELAY);
    envioEmAndamento = false;
  }
}

// Mensagens e limpeza dos impactos confirmados ficam no loop (núcleo 1).
void processarRespostasHttp() {
  RespostaHttp r;
  while (xQueueReceive(filaRespostasHttp, &r, 0) == pdTRUE) {
    if (r.codigo > 0) {
      Serial.printf("Enviado! Resposta do servidor: %d\n", r.codigo);
    } else {
      Serial.printf("Erro ao enviar: %s\n", r.erro);
    }
    if (r.codigo == 200 && r.nEventos > 0) {
      int restantes = nEventosPendentes - r.nEventos;
      for (int i = 0; i < restantes; i++) {
        eventosPendentes[i] = eventosPendentes[i + r.nEventos];
      }
      nEventosPendentes = max(0, restantes);
    }
    if (modoLog) {
      Serial.printf("H,%lu,%lu,%.3f,%d,%s\n", millis(), (unsigned long)r.seq, r.latenciaMs, r.codigo,
                    r.reuso ? "reuso" : "novo");
    }
  }
}

// ---------------------------------------------------------------------------
// Stream UDP para a visualização 3D
// ---------------------------------------------------------------------------

void enviarAmostraUdp() {
  if (WiFi.status() != WL_CONNECTED || !lis3dhOk || !gravidadeIniciada || strlen(IP_SERVIDOR) == 0) {
    return;
  }
  float inclinacao = calcularInclinacao();
  char pacote[112];
  int n = snprintf(pacote, sizeof(pacote), "V,%lu,%lu,%.4f,%.4f,%.4f,%.3f,%.2f",
                   (unsigned long)++sequenciaUdp, millis(), gravidade.x, gravidade.y, gravidade.z,
                   picoDinamicaUdp, isnan(inclinacao) ? -1.0f : inclinacao);
  picoDinamicaUdp = 0;
  if (n <= 0) {
    return;
  }
  udp.beginPacket(IP_SERVIDOR, PORTA_UDP);
  udp.write(reinterpret_cast<const uint8_t*>(pacote), n);
  udp.endPacket();
}

// ---------------------------------------------------------------------------
// Detecção de impactos
// ---------------------------------------------------------------------------

static void enfileirarImpacto(const EventoImpacto& e) {
  if (nEventosPendentes >= MAX_EVENTOS_PENDENTES) {
    // fila cheia (servidor fora do ar): descarta o mais antigo
    for (int i = 1; i < MAX_EVENTOS_PENDENTES; i++) {
      eventosPendentes[i - 1] = eventosPendentes[i];
    }
    nEventosPendentes--;
    eventosDescartados++;
  }
  eventosPendentes[nEventosPendentes++] = e;
  Serial.printf("Impacto: pico %.2f g, %u ms, inclinação %.1f° -> %.1f°%s\n", e.picoG, e.duracaoMs,
                e.inclAntes, e.inclDepois, e.saturado ? " (SATUROU ±2 g)" : "");
  if (modoLog) {
    Serial.printf("E,%lu,%u,%.3f,%.3f,%.3f,%.3f,%.1f,%.1f,%d\n", (unsigned long)e.inicioMs, e.duracaoMs, e.picoG,
                  e.dx, e.dy, e.dz, e.inclAntes, e.inclDepois, e.saturado ? 1 : 0);
  }
}

void detectarImpacto(const Vetor3& a, float dyn, float dx, float dy, float dz) {
  unsigned long agora = millis();
  bool saturado = fabsf(a.x) >= LIMITE_SATURACAO_G || fabsf(a.y) >= LIMITE_SATURACAO_G ||
                  fabsf(a.z) >= LIMITE_SATURACAO_G;

  switch (estadoImpacto) {
    case IMPACTO_OCIOSO:
      if (dyn < limiarImpacto * 0.5f) {
        inclinacaoEstavel = calcularInclinacao();
      }
      if (dyn >= limiarImpacto && agora - fimImpactoMs >= IMPACTO_INTERVALO_MIN_MS) {
        impactoAtual = { (uint32_t)agora, 0, dyn, dx, dy, dz, inclinacaoEstavel, NAN, saturado };
        ultimoAcimaMs = agora;
        estadoImpacto = IMPACTO_ATIVO;
      }
      break;

    case IMPACTO_ATIVO:
      if (dyn >= limiarImpacto * 0.5f) {
        ultimoAcimaMs = agora;
      }
      if (dyn > impactoAtual.picoG) {
        impactoAtual.picoG = dyn;
        impactoAtual.dx = dx;
        impactoAtual.dy = dy;
        impactoAtual.dz = dz;
      }
      impactoAtual.saturado = impactoAtual.saturado || saturado;
      if (agora - ultimoAcimaMs >= IMPACTO_SILENCIO_MS || agora - impactoAtual.inicioMs >= IMPACTO_DURACAO_MAX_MS) {
        impactoAtual.duracaoMs = (uint16_t)(ultimoAcimaMs - impactoAtual.inicioMs + INTERVALO_AMOSTRA_MS);
        fimImpactoMs = agora;
        estadoImpacto = IMPACTO_ASSENTANDO;
      }
      break;

    case IMPACTO_ASSENTANDO:
      // espera a gravidade filtrada assentar para medir a inclinação final
      if (agora - fimImpactoMs >= IMPACTO_ASSENTAMENTO_MS || dyn >= limiarImpacto) {
        impactoAtual.inclDepois = calcularInclinacao();
        enfileirarImpacto(impactoAtual);
        estadoImpacto = IMPACTO_OCIOSO;
      }
      break;
  }
}

void carregarLimiarImpacto() {
  preferencias.begin("vital", true);
  limiarImpacto = preferencias.getFloat("impacto", LIMIAR_IMPACTO_PADRAO_G);
  preferencias.end();
  if (limiarImpacto < LIMIAR_IMPACTO_MIN_G || limiarImpacto > LIMIAR_IMPACTO_MAX_G) {
    limiarImpacto = LIMIAR_IMPACTO_PADRAO_G;
  }
}

void ajustarLimiarImpacto(const String& texto) {
  String valor = texto;
  valor.trim();
  valor.replace(',', '.');
  float novo = valor.toFloat();
  if (valor.length() == 0 || novo < LIMIAR_IMPACTO_MIN_G || novo > LIMIAR_IMPACTO_MAX_G) {
    Serial.printf("LIMIAR_IMPACTO_ERR|fora_da_faixa_%.1f_a_%.1f\n", LIMIAR_IMPACTO_MIN_G, LIMIAR_IMPACTO_MAX_G);
    return;
  }
  limiarImpacto = novo;
  preferencias.begin("vital", false);
  preferencias.putFloat("impacto", novo);
  preferencias.end();
  Serial.printf("LIMIAR_IMPACTO_OK|%.2f\n", limiarImpacto);
}

// ---------------------------------------------------------------------------
// Compensação do calor da placa no DHT11, salva em NVS
// ---------------------------------------------------------------------------

static float pressaoSaturacao(float t) {
  return 6.112f * expf(17.62f * t / (243.12f + t));  // hPa, fórmula de Magnus
}

void compensarLeitura(float& temperatura, float& umidade) {
  if (compensacaoTemp <= 0.0f || isnan(temperatura)) {
    return;
  }
  float corrigida = temperatura - compensacaoTemp;
  if (!isnan(umidade)) {
    // mesmo vapor d'água, ar mais frio -> umidade relativa maior
    umidade = constrain(umidade * pressaoSaturacao(temperatura) / pressaoSaturacao(corrigida), 0.0f, 100.0f);
  }
  temperatura = corrigida;
}

void carregarCompensacao() {
  preferencias.begin("vital", true);
  compensacaoTemp = preferencias.getFloat("compTemp", COMPENSACAO_TEMP_PADRAO_C);
  preferencias.end();
  if (isnan(compensacaoTemp) || compensacaoTemp < 0.0f || compensacaoTemp > COMPENSACAO_TEMP_MAX_C) {
    compensacaoTemp = COMPENSACAO_TEMP_PADRAO_C;
  }
}

void ajustarCompensacao(const String& texto) {
  String valor = texto;
  valor.trim();
  valor.replace(',', '.');
  if (valor.length() > 0) {
    float nova = valor.toFloat();
    if (nova < 0.0f || nova > COMPENSACAO_TEMP_MAX_C) {
      Serial.printf("COMPENSACAO_TEMP_ERR|fora_da_faixa_0_a_%.0f\n", COMPENSACAO_TEMP_MAX_C);
      return;
    }
    compensacaoTemp = nova;
    preferencias.begin("vital", false);
    preferencias.putFloat("compTemp", nova);
    preferencias.end();
  }
  Serial.printf("COMPENSACAO_TEMP_OK|%.1f\n", compensacaoTemp);
}

// ---------------------------------------------------------------------------
// Modo de energia (eco / normal), salvo em NVS
// ---------------------------------------------------------------------------

void carregarModoEnergia() {
  preferencias.begin("vital", true);
  modoEco = preferencias.getBool("eco", true);
  preferencias.end();
}

void aplicarModoEnergia() {
  setCpuFrequencyMhz(modoEco ? CPU_MHZ_ECO : CPU_MHZ_NORMAL);
  intervaloUdpMs = modoEco ? INTERVALO_UDP_ECO_MS : INTERVALO_UDP_NORMAL_MS;
  Serial.printf("Modo de energia: %s (CPU %lu MHz, UDP %lu Hz)\n", modoEco ? "eco" : "normal",
                (unsigned long)getCpuFrequencyMhz(), 1000UL / intervaloUdpMs);
}

void ajustarModoEnergia(const String& texto) {
  String modo = texto;
  modo.trim();
  modo.toLowerCase();
  if (modo == "eco" || modo == "normal") {
    modoEco = (modo == "eco");
    preferencias.begin("vital", false);
    preferencias.putBool("eco", modoEco);
    preferencias.end();
    aplicarModoEnergia();
    dht.begin();  // recalcula o timeout de leitura do DHT para o novo clock
  } else if (modo.length() > 0) {
    Serial.println("MODO_ENERGIA_ERR|use_eco_ou_normal");
    return;
  }
  Serial.printf("MODO_ENERGIA_OK|%s|%lu|%lu\n", modoEco ? "eco" : "normal",
                (unsigned long)getCpuFrequencyMhz(), 1000UL / intervaloUdpMs);
}

// ---------------------------------------------------------------------------
// Benchmark dos métodos de estimativa de inclinação (custo no ESP32)
// ---------------------------------------------------------------------------

static float anguloEntre(const Vetor3& v, const Vetor3& r) {
  float produto = v.x * r.x + v.y * r.y + v.z * r.z;
  float mv = sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);
  float mr = sqrtf(r.x * r.x + r.y * r.y + r.z * r.z);
  return acosf(constrain(produto / (mv * mr), -1.0f, 1.0f)) * RAD_TO_DEG;
}

void executarBenchmark() {
  const int N_ENTRADA = 256;
  const int N_ITER = 20000;
  const int REPETICOES = 5;
  const int JANELA_MM = 20;
  static Vetor3 entrada[N_ENTRADA];
  const Vetor3 ref = { 0.0f, 0.0f, 1.0f };

  // Entrada sintética: placa a ~30° com ruído de ±5 mg.
  randomSeed(1234);
  for (int i = 0; i < N_ENTRADA; i++) {
    entrada[i].x = 0.0f + random(-50, 51) / 10000.0f;
    entrada[i].y = 0.5f + random(-50, 51) / 10000.0f;
    entrada[i].z = 0.866f + random(-50, 51) / 10000.0f;
  }

  volatile float sumidouro = 0;
  Serial.printf("BENCH_INICIO|%lu\n", (unsigned long)getCpuFrequencyMhz());

  for (int metodo = 0; metodo < 4; metodo++) {
    float melhorUs = 1e9f, somaUs = 0;
    for (int rep = 0; rep < REPETICOES; rep++) {
      // estado de cada método
      Vetor3 ema = entrada[0];
      Vetor3 buffer[JANELA_MM];
      Vetor3 soma = { 0, 0, 0 };
      for (int k = 0; k < JANELA_MM; k++) {
        buffer[k] = entrada[0];
        soma.x += entrada[0].x; soma.y += entrada[0].y; soma.z += entrada[0].z;
      }
      int pos = 0;
      float kx = anguloEntre(entrada[0], ref), kp = 1.0f;
      const float kq = 0.0025f, kr = 0.25f;

      unsigned long t0 = micros();
      for (int i = 0; i < N_ITER; i++) {
        const Vetor3& a = entrada[i & (N_ENTRADA - 1)];
        float ang;
        if (metodo == 0) {               // bruto
          ang = anguloEntre(a, ref);
        } else if (metodo == 1) {        // EMA vetorial (VITAL)
          ema.x += ALFA_GRAVIDADE * (a.x - ema.x);
          ema.y += ALFA_GRAVIDADE * (a.y - ema.y);
          ema.z += ALFA_GRAVIDADE * (a.z - ema.z);
          ang = anguloEntre(ema, ref);
        } else if (metodo == 2) {        // média móvel vetorial
          soma.x += a.x - buffer[pos].x;
          soma.y += a.y - buffer[pos].y;
          soma.z += a.z - buffer[pos].z;
          buffer[pos] = a;
          pos = (pos + 1) % JANELA_MM;
          Vetor3 media = { soma.x / JANELA_MM, soma.y / JANELA_MM, soma.z / JANELA_MM };
          ang = anguloEntre(media, ref);
        } else {                         // Kalman 1D sobre o ângulo
          float z = anguloEntre(a, ref);
          kp += kq;
          float ganho = kp / (kp + kr);
          kx += ganho * (z - kx);
          kp *= (1.0f - ganho);
          ang = kx;
        }
        sumidouro = sumidouro + ang;
      }
      float us = (micros() - t0) / (float)N_ITER;
      somaUs += us;
      if (us < melhorUs) melhorUs = us;
    }

    const char* nomes[] = { "bruto", "ema", "media_movel", "kalman" };
    const int bytesEstado[] = { 0, (int)sizeof(Vetor3),
                                (int)(sizeof(Vetor3) * (JANELA_MM + 1) + sizeof(int)),
                                (int)(2 * sizeof(float)) };
    Serial.printf("BENCH|%s|%.3f|%.3f|%d\n", nomes[metodo], melhorUs, somaUs / REPETICOES, bytesEstado[metodo]);
  }
  Serial.printf("BENCH_FIM|%d\n", (int)(sumidouro != 0));
}
