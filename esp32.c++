/*
  ESP32 + DHT11/DHT22 + sensor de inclinação -> envia dados via Wi-Fi
  para o dashboard VITAL (projeto Next.js).

  Ajuste para o novo dashboard:
  - o motion state agora é uma escala/medidor (0 a 100)
  - a UI mostra o quanto o sensor está inclinado em vez de um bool simples
  - mantém o mesmo padrão visual e os campos já existentes do design

  Ligações:
    DHT DATA -> GPIO4
    Sensor de inclinação -> GPIO5 (com pull-up interno)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <Preferences.h>

// ---- Configurações da rede ----
const char* SSID_WIFI_PADRAO   = "";
const char* SENHA_WIFI_PADRAO  = "";
const char* IP_SERVIDOR = ""; // IP da máquina rodando o VITAL
const int   PORTA_SERVIDOR = ;

// ---- Sensor de temperatura/umidade ----
#define DHT_PIN  4
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);

// ---- Sensor de inclinação ----
#define PINO_INCLINACAO 5

// O dashboard passa a interpretar motionState como uma escala de 0 a 100.
// Como o sensor de inclinação usado aqui é digital (ligado/desligado),
// mapeamos "não inclinado" para 0 e "inclinado" para 100.
const float MOTION_STATE_MIN = 0.0f;
const float MOTION_STATE_MAX = 100.0f;

unsigned long ultimoEnvio = 0;
const unsigned long INTERVALO_ENVIO_MS = 3000;

Preferences preferencias;
String ssidAtual = SSID_WIFI_PADRAO;
String senhaAtual = SENHA_WIFI_PADRAO;
String bufferSerial = "";

void conectarWiFi();
void lerEEnviar();
void lerComandosSerial();
void processarComandoSerial(String linha);
void aplicarCredenciaisWiFi(const String& novoSSID, const String& novaSenha);
void carregarCredenciaisWiFi();
void salvarCredenciaisWiFi(const String& novoSSID, const String& novaSenha);
float calcularMotionState(bool inclinado);

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

void setup() {
  Serial.begin(115200);

  dht.begin();
  pinMode(PINO_INCLINACAO, INPUT_PULLUP);

  carregarCredenciaisWiFi();
  conectarWiFi();
}

void loop() {
  lerComandosSerial();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi caiu, tentando reconectar...");
    conectarWiFi();
  }

  if (millis() - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = millis();
    lerEEnviar();
  }
}

void conectarWiFi() {
  Serial.printf("Conectando na rede %s", ssidAtual.c_str());
  WiFi.begin(ssidAtual.c_str(), senhaAtual.c_str());

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 30) {
    delay(500);
    Serial.print(".");
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConectado!");
    Serial.print("IP do ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nFalha ao conectar. Vou continuar tentando no loop().");
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
  conectarWiFi();
}

void processarComandoSerial(String linha) {
  linha.trim();
  if (linha.length() == 0) {
    return;
  }

  if (!linha.startsWith("WIFI_CONFIG|")) {
    Serial.println("WIFI_CONFIG_ERR|comando_desconhecido");
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

float calcularMotionState(bool inclinado) {
  // Mantém o mesmo princípio visual do design: métrica contínua de 0 a 100.
  // O valor 0 representa nível/estável e 100 representa inclinação máxima.
  return inclinado ? MOTION_STATE_MAX : MOTION_STATE_MIN;
}

void lerEEnviar() {
  float temperatura = dht.readTemperature();
  float umidade = dht.readHumidity();

  // O módulo de inclinação pode ter polaridade invertida em relação ao nível lógico
  // esperado pela lógica do dashboard. Ajustamos a leitura aqui para manter o
  // offset consistente: quando o sensor está em estado de alerta, o motion state
  // deve refletir 100% e não aparecer como estável.
  bool inclinado = (digitalRead(PINO_INCLINACAO) == HIGH);
  float motionState = calcularMotionState(inclinado);

  if (isnan(temperatura) || isnan(umidade)) {
    Serial.println("Erro: falha ao ler o sensor DHT. Pulando este envio.");
    return;
  }

  Serial.printf(
    "Temp: %.1fC  Umidade: %.1f%%  Inclinado: %s  MotionState: %.0f\n",
    temperatura,
    umidade,
    inclinado ? "sim" : "nao",
    motionState
  );

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Sem Wi-Fi, não foi possível enviar.");
    return;
  }

  HTTPClient http;
  String url = String("http://") + IP_SERVIDOR + ":" + PORTA_SERVIDOR + "/api/reading";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // O dashboard deseja um estado de movimento em escala, não apenas um booleano.
  // Mantemos o campo booleano para compatibilidade, mas o principal é motionState.
  String corpo = "{";
  corpo += "\"temperatura\":" + String(temperatura, 1) + ",";
  corpo += "\"umidade\":" + String(umidade, 1) + ",";
  corpo += "\"motionState\":" + String(motionState, 0) + ",";
  corpo += "\"inclinado\":" + String(inclinado ? "true" : "false");
  corpo += "}";

  int codigoResposta = http.POST(corpo);

  if (codigoResposta > 0) {
    Serial.printf("Enviado! Resposta do servidor: %d\n", codigoResposta);
  } else {
    Serial.printf("Erro ao enviar: %s\n", http.errorToString(codigoResposta).c_str());
  }

  http.end();
}
