"""Coleta de dados do VITAL para a avaliação quantitativa (artigo / AP2).

Rode na pasta do projeto (VITAL), com o ESP32 na USB e o Serial Monitor
do Arduino IDE FECHADO:

  avaliacao\\.venv\\Scripts\\python avaliacao\\coletar.py bench
  avaliacao\\.venv\\Scripts\\python avaliacao\\coletar.py inclinacao
  avaliacao\\.venv\\Scripts\\python avaliacao\\coletar.py degrau
  avaliacao\\.venv\\Scripts\\python avaliacao\\coletar.py wifi --minutos 30
  avaliacao\\.venv\\Scripts\\python avaliacao\\coletar.py aquecimento --condicao barreira

Os arquivos CSV vão para avaliacao/dados/. Depois rode analisar.py.
"""

import argparse
import csv
import json
import queue
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import serial
from serial.tools import list_ports

PASTA_DADOS = Path(__file__).resolve().parent / "dados"
URL_PAINEL = "http://192.168.15.61:3000/api/reading"


# ---------------------------------------------------------------------------
# Comunicação com o ESP32
# ---------------------------------------------------------------------------

class Esp32:
    def __init__(self, porta, baud=115200):
        s = serial.Serial()
        s.port = porta
        s.baudrate = baud
        s.timeout = 0.2
        s.dtr = False  # não reiniciar a placa ao abrir a porta
        s.rts = False
        s.open()
        self.s = s
        self.fila = queue.Queue()       # dados (R, D, H, BENCH...) e mensagens
        self.respostas = queue.Queue()  # confirmações de comando (..._OK|, ..._ERR|)
        self._rodando = True
        threading.Thread(target=self._ler, daemon=True).start()

    def _ler(self):
        resto = b""
        while self._rodando:
            try:
                dados = self.s.read(4096)
            except serial.SerialException:
                break
            if not dados:
                continue
            resto += dados
            while b"\n" in resto:
                linha, resto = resto.split(b"\n", 1)
                texto = linha.decode("utf-8", "replace").strip()
                # confirmações vão para uma fila própria: assim o Gravador (que
                # consome self.fila em outra thread) não as engole
                destino = self.respostas if ("_OK|" in texto or "_ERR|" in texto) else self.fila
                destino.put((time.time(), texto))

    def enviar(self, comando):
        self.s.write((comando + "\n").encode())

    def comando(self, comando, resposta, timeout=8.0, tentativas=2):
        """Envia um comando e espera a linha de confirmação."""
        while not self.respostas.empty():  # descarta confirmações antigas
            self.respostas.get_nowait()
        for _ in range(tentativas):
            self.enviar(comando)
            fim = time.time() + timeout
            while time.time() < fim:
                try:
                    _, linha = self.respostas.get(timeout=0.2)
                except queue.Empty:
                    continue
                if linha.startswith(resposta):
                    return linha
        raise TimeoutError(f"O ESP32 não respondeu a {comando!r}. Confira a porta e se o firmware novo está gravado.")

    def fechar(self):
        try:
            self.enviar("LOG_OFF")
            time.sleep(0.2)
        finally:
            self._rodando = False
            time.sleep(0.3)
            self.s.close()


class Gravador:
    """Consome as linhas do ESP32 numa thread e grava as de interesse em CSV,
    acrescentando o rótulo atual (definido pela thread principal)."""

    def __init__(self, esp, prefixos, arquivos, cabecalhos):
        self.esp = esp
        self.rotulo = {}
        self.contagem = {p: 0 for p in prefixos}
        self._arquivos = {p: open(arquivos[p], "w", newline="", encoding="utf-8") for p in prefixos}
        self._csv = {p: csv.writer(self._arquivos[p]) for p in prefixos}
        self._cab_rotulo = {}
        for p in prefixos:
            self._csv[p].writerow(cabecalhos[p])
        self._rodando = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while self._rodando:
            try:
                _, linha = self.esp.fila.get(timeout=0.2)
            except queue.Empty:
                continue
            partes = linha.split(",")
            prefixo = partes[0]
            if prefixo not in self._csv:
                continue
            rotulo = dict(self.rotulo)
            self._csv[prefixo].writerow(partes[1:] + rotulo.get(prefixo, []))
            self.contagem[prefixo] += 1

    def parar(self):
        time.sleep(0.5)
        self._rodando = False
        self._thread.join()
        for f in self._arquivos.values():
            f.close()


def carimbo():
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def ler_angulo(texto, padrao):
    while True:
        valor = input(texto).strip().replace(",", ".")
        if valor == "":
            return float(padrao)
        try:
            return float(valor)
        except ValueError:
            print("  Digite só o número (ex.: 14.6) ou Enter para usar o valor sugerido.")


def contagem_regressiva(segundos, mensagem="  gravando"):
    for restante in range(int(segundos), 0, -1):
        print(f"\r{mensagem}... {restante:2d} s ", end="", flush=True)
        time.sleep(1)
    print(f"\r{mensagem}... ok      ")


# ---------------------------------------------------------------------------
# Ensaios
# ---------------------------------------------------------------------------

def ensaio_bench(esp, args):
    destino = PASTA_DADOS / f"bench_{carimbo()}.csv"
    print("Medindo o custo de cada método no ESP32 (leva alguns segundos)...")
    esp.enviar("BENCH")
    linhas = []
    mhz = ""
    fim = time.time() + 60
    while time.time() < fim:
        try:
            _, linha = esp.fila.get(timeout=0.5)
        except queue.Empty:
            continue
        if linha.startswith("BENCH_INICIO|"):
            mhz = linha.split("|")[1]
            print(f"  CPU a {mhz} MHz")
        if linha.startswith("BENCH|"):
            linhas.append(linha.split("|")[1:] + [mhz])
            print("  " + linha)
        if linha.startswith("BENCH_FIM"):
            break
    with open(destino, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["metodo", "us_min", "us_media", "bytes_estado", "cpu_mhz"])
        w.writerows(linhas)
    print(f"Salvo em {destino}")


def ensaio_inclinacao(esp, args):
    destino = PASTA_DADOS / f"inclinacao_{carimbo()}.csv"
    objetos = args.referencia == "objetos"
    print(__doc_inclinacao_objetos__ if objetos else __doc_inclinacao__)
    input("Com tudo pronto e a placa deitada (0°), pressione Enter para começar...")

    esp.comando("LOG_ON", "LOG_OK")
    g = Gravador(esp, ["R"], {"R": destino},
                 {"R": ["t_ms", "ax", "ay", "az", "rep", "ang_nominal", "ang_app"]})
    try:
        for rep in range(1, args.reps + 1):
            print(f"\n=== Repetição {rep}/{args.reps} ===")
            for nominal in args.angulos:
                if objetos:
                    dica = DICAS_OBJETOS.get(nominal, "use o esquadro ou o transferidor")
                    pergunta = f"Posicione em {nominal:g}° ({dica}). Firme? Enter: "
                else:
                    pergunta = f"Incline até ~{nominal}°. Firme? Digite o ângulo que o APP mostra (Enter = {nominal}): "
                lido = ler_angulo(pergunta, nominal)
                g.rotulo = {"R": [rep, nominal, lido]}
                contagem_regressiva(args.segundos, "  segure parado, gravando")
                g.rotulo = {}
    finally:
        g.parar()
    print(f"\nAmostras gravadas: {g.contagem['R']}. Salvo em {destino}")


__doc_inclinacao__ = """
ENSAIO DE INCLINAÇÃO (estático)
 1. Prenda a placa (com fita) numa base rígida e plana: uma tábua, um livro
    grosso ou uma régua larga. Ela não pode se mexer em relação à base.
 2. Apoie o celular com o app de nível NA MESMA BASE, alinhado à placa.
 3. Você vai inclinar a base sempre girando em torno do MESMO eixo
    (ex.: levantando só a borda da frente).
 4. Para cada ângulo: incline, apoie firme (use livros como calço), espere
    o app estabilizar, digite o valor que o app mostra e pressione Enter.
    Não toque na base durante a contagem de 10 s.
"""

__doc_inclinacao_objetos__ = """
ENSAIO DE INCLINAÇÃO (estático) — ângulos de referência dados por objetos
 1. Prenda o VITAL (com fita) numa base rígida e plana: um livro grosso,
    uma tábua ou uma régua larga. Ele não pode se mexer em relação à base.
 2. Os ângulos vêm da geometria, sem celular:
      0°  base deitada na mesa
     30°  esquadro 30/60 em pé na mesa, apoiado no lado reto MAIOR; encoste
          a base no lado inclinado (hipotenusa)
     45°  esquadro 45° em pé na mesa; base encostada no lado inclinado
     60°  esquadro 30/60 em pé, apoiado no lado reto MENOR; base no lado inclinado
     90°  base em pé, encostada numa parede ou na lateral de uma caixa
    (sem esquadro, use um transferidor para marcar o ângulo num papelão)
 3. Gire sempre em torno do MESMO eixo: a mesma borda da base fica na mesa.
 4. Em cada ângulo: posicione, confira que a base encosta bem no esquadro,
    aperte Enter e não toque durante a contagem de 10 s. Se o ângulo real
    for outro, digite o valor antes do Enter.
"""

DICAS_OBJETOS = {
    0: "base deitada na mesa",
    30: "esquadro 30/60 sobre o lado maior",
    45: "esquadro de 45°",
    60: "esquadro 30/60 sobre o lado menor",
    90: "base em pé encostada na parede",
}


def ensaio_degrau(esp, args):
    destino = PASTA_DADOS / f"degrau_{carimbo()}.csv"
    print("""
ENSAIO DE DEGRAU (tempo de resposta)
 Coloque um batente vertical (parede, caixa ou livro em pé). Em cada
 repetição: deixe a base deitada (0°); pressione Enter; quando aparecer
 AGORA, levante a base RÁPIDO até ficar em pé (90°) encostada no batente,
 e segure parada até o fim da contagem.
""")
    esp.comando("LOG_ON", "LOG_OK")
    g = Gravador(esp, ["R"], {"R": destino}, {"R": ["t_ms", "ax", "ay", "az", "rep"]})
    try:
        for rep in range(1, args.reps + 1):
            input(f"\nRepetição {rep}/{args.reps}: base deitada e parada? Enter...")
            g.rotulo = {"R": [rep]}
            time.sleep(2.0)
            print("  >>> AGORA! levante até 90° <<<")
            contagem_regressiva(args.segundos - 2, "  segure parado")
            g.rotulo = {}
    finally:
        g.parar()
    print(f"\nAmostras gravadas: {g.contagem['R']}. Salvo em {destino}")


def ensaio_wifi(esp, args):
    try:
        with urllib.request.urlopen(args.url_painel, timeout=3) as r:
            ok = r.status == 200
    except Exception:
        ok = False
    if not ok:
        print(f"ATENÇÃO: o painel não respondeu em {args.url_painel}. Inicie o dashboard antes.")
        if input("Continuar mesmo assim? (s/N) ").strip().lower() != "s":
            return

    c = carimbo()
    arq_wifi = PASTA_DADOS / f"wifi_{c}.csv"
    arq_dht = PASTA_DADOS / f"dht_{c}.csv"
    esp.comando("LOG_ON", "LOG_OK")
    g = Gravador(esp, ["H", "D"], {"H": arq_wifi, "D": arq_dht},
                 {"H": ["t_ms", "seq", "lat_ms", "codigo", "modo", "bloco"],
                  "D": ["t_ms", "temperatura", "umidade", "ok"]})

    modos = ["novo", "reuso"]
    n_blocos = max(2, round(args.minutos / args.bloco))
    print(f"\nENSAIO DE COMUNICAÇÃO + DHT11: {n_blocos} blocos de {args.bloco} min, "
          f"alternando conexão nova / reaproveitada. Deixe a placa parada e o PC ligado.")
    try:
        for b in range(n_blocos):
            modo = modos[b % 2]
            esp.comando(f"MODO_HTTP|{modo}", "MODO_HTTP_OK")
            g.rotulo = {"H": [b + 1]}
            fim = time.time() + args.bloco * 60
            while time.time() < fim:
                falta = int(fim - time.time())
                print(f"\r  bloco {b + 1}/{n_blocos} ({modo:5s}) faltam {falta // 60:02d}:{falta % 60:02d}  "
                      f"envios registrados: {g.contagem['H']}  leituras DHT: {g.contagem['D']}   ",
                      end="", flush=True)
                time.sleep(1)
            print()
    finally:
        g.rotulo = {}
        esp.comando("MODO_HTTP|novo", "MODO_HTTP_OK")
        g.parar()
    print(f"Salvo em {arq_wifi} e {arq_dht}")


def porta_presente(porta):
    return any(p.device.upper() == porta.upper() for p in list_ports.comports())


def esperar(condicao, mensagem, intervalo=1.0):
    inicio = time.time()
    while not condicao():
        decorrido = int(time.time() - inicio)
        print(f"\r{mensagem} ({decorrido // 60:02d}:{decorrido % 60:02d}) ", end="", flush=True)
        time.sleep(intervalo)
    print()


def gravar_dht(esp, w, fase, condicao, minutos=None, fim_quando=None):
    """Grava as linhas D do ESP32 até passar `minutos` ou `fim_quando()` ser
    verdadeiro. Devolve o número de leituras."""
    n = 0
    fim = time.time() + minutos * 60 if minutos else None
    while True:
        if fim and time.time() >= fim:
            break
        if fim_quando and fim_quando():
            break
        try:
            t_pc, linha = esp.fila.get(timeout=0.5)
        except queue.Empty:
            continue
        if not linha.startswith("D,"):
            continue
        partes = linha.split(",")
        if len(partes) != 5:
            continue
        w.writerow([datetime.fromtimestamp(t_pc).isoformat(timespec="seconds"), fase, condicao] + partes[1:])
        n += 1
        if fim:
            falta = int(fim - time.time())
            print(f"\r  {fase}: {n} leituras, {partes[2]} °C {partes[3]} %  faltam {falta // 60:02d}:{falta % 60:02d}  ",
                  end="", flush=True)
    print()
    return n


def abrir_quando_aparecer(porta, tentativas=20):
    for _ in range(tentativas):
        try:
            return Esp32(porta)
        except serial.SerialException:
            time.sleep(0.5)
    raise serial.SerialException(f"{porta} apareceu mas não abriu")


def ensaio_aquecimento(args):
    """Autoaquecimento do DHT11: partida a frio, sem interação pelo teclado.

    1. (opcional) grava `--antes` min com a placa quente, como está agora;
    2. espera o USB ser desconectado e conta o tempo desligado;
    3. espera o USB voltar e grava `--minutos` min desde a partida a frio.
    As primeiras leituras após a partida ≈ temperatura do ambiente."""
    destino = PASTA_DADOS / f"aquecimento_{args.condicao}_{carimbo()}.csv"
    with open(destino, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["hora_pc", "fase", "condicao", "t_ms", "temperatura", "umidade", "ok"])

        if porta_presente(args.porta):
            esp = Esp32(args.porta)
            time.sleep(1.0)
            esp.comando("LOG_ON", "LOG_OK")
            if args.antes > 0:
                print(f"Gravando {args.antes:g} min com a placa quente (fase 'antes')...")
                gravar_dht(esp, w, "antes", args.condicao_antes, minutos=args.antes,
                           fim_quando=lambda: not porta_presente(args.porta))
                f.flush()
            print(">>> DESCONECTE o USB do VITAL agora <<<", flush=True)
            gravar_dht(esp, w, "antes", args.condicao_antes, fim_quando=lambda: not porta_presente(args.porta))
            try:
                esp.fechar()
            except Exception:
                pass
        desligado = time.time()
        f.flush()
        print(f"Desligado às {datetime.now():%H:%M:%S}. Religue depois de pelo menos {args.esfriar:g} min.", flush=True)

        esperar(lambda: porta_presente(args.porta), "  esperando o USB voltar", intervalo=0.5)
        ligado = time.time()
        min_desligado = (ligado - desligado) / 60
        print(f"Ligado às {datetime.now():%H:%M:%S}, ficou {min_desligado:.1f} min desligado.", flush=True)
        if min_desligado < args.esfriar:
            print(f"ATENÇÃO: menos de {args.esfriar:g} min desligado; a placa pode não ter esfriado.", flush=True)

        esp = abrir_quando_aparecer(args.porta)
        try:
            try:  # também serve para esperar o boot terminar
                modo_energia = esp.comando("MODO_ENERGIA", "MODO_ENERGIA_OK", timeout=5.0, tentativas=6).split("|")[1:3]
                print(f"Modo de energia: {modo_energia[0]} ({modo_energia[1]} MHz)", flush=True)
            except TimeoutError:
                modo_energia = None  # firmware sem MODO_ENERGIA
            esp.comando("LOG_ON", "LOG_OK", timeout=5.0, tentativas=6)
            restante = args.minutos - (time.time() - ligado) / 60
            n = gravar_dht(esp, w, "aquecimento", args.condicao, minutos=restante)
        finally:
            try:
                esp.fechar()
            except Exception:
                pass

    with open(destino.with_suffix(".json"), "w", encoding="utf-8") as fj:
        json.dump({"condicao": args.condicao, "desligado": datetime.fromtimestamp(desligado).isoformat(timespec="seconds"),
                   "ligado": datetime.fromtimestamp(ligado).isoformat(timespec="seconds"),
                   "minutos_desligado": round(min_desligado, 1),
                   "modo_energia": f"{modo_energia[0]} ({modo_energia[1]} MHz)" if modo_energia else None},
                  fj, ensure_ascii=False, indent=2)
    print(f"{n} leituras após a partida. Salvo em {destino}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("ensaio", choices=["bench", "inclinacao", "degrau", "wifi", "aquecimento"])
    p.add_argument("--condicao", default="barreira", help="rótulo do ensaio de aquecimento")
    p.add_argument("--condicao-antes", default="sem_barreira", help="rótulo da montagem durante a fase antes")
    p.add_argument("--antes", type=float, default=5, help="aquecimento: minutos gravados antes de desligar")
    p.add_argument("--esfriar", type=float, default=30, help="aquecimento: minutos mínimos desligado")
    p.add_argument("--porta", default="COM3")
    p.add_argument("--referencia", choices=["app", "objetos"], default="objetos",
                   help="inclinação: ângulo lido no app do celular ou dado por objetos (mesa, esquadro, parede)")
    p.add_argument("--angulos", type=float, nargs="+", default=None,
                   help="inclinação (app: 0 15 30 45 60 75 90; objetos: 0 30 45 60 90)")
    p.add_argument("--reps", type=int, default=None, help="repetições (inclinação: 3, degrau: 5)")
    p.add_argument("--segundos", type=float, default=None, help="duração de cada janela (incl.: 10, degrau: 8)")
    p.add_argument("--minutos", type=float, default=None, help="duração (Wi-Fi: 30, aquecimento: 45)")
    p.add_argument("--bloco", type=float, default=5, help="minutos por bloco no ensaio de Wi-Fi")
    p.add_argument("--url-painel", default=URL_PAINEL)
    args = p.parse_args()

    if args.reps is None:
        args.reps = 5 if args.ensaio == "degrau" else 3
    if args.angulos is None:
        args.angulos = [0, 30, 45, 60, 90] if args.referencia == "objetos" else [0, 15, 30, 45, 60, 75, 90]
    if args.minutos is None:
        args.minutos = 45 if args.ensaio == "aquecimento" else 30
    if args.segundos is None:
        args.segundos = 8 if args.ensaio == "degrau" else 10

    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    if args.ensaio == "aquecimento":
        try:
            ensaio_aquecimento(args)
        except KeyboardInterrupt:
            print("\nInterrompido.")
        return
    try:
        esp = Esp32(args.porta)
    except serial.SerialException as e:
        sys.exit(f"Não consegui abrir {args.porta}: {e}\nFeche o Serial Monitor do Arduino IDE e tente de novo.")

    time.sleep(1.0)
    try:
        {"bench": ensaio_bench, "inclinacao": ensaio_inclinacao,
         "degrau": ensaio_degrau, "wifi": ensaio_wifi}[args.ensaio](esp, args)
    except KeyboardInterrupt:
        print("\nInterrompido.")
    finally:
        esp.fechar()


if __name__ == "__main__":
    main()
