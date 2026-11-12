"""Análise da avaliação quantitativa do VITAL.

  avaliacao\\.venv\\Scripts\\python avaliacao\\analisar.py

Lê os CSV mais recentes de avaliacao/dados e gera em avaliacao/resultados:
  - tabelas (CSV com ; e vírgula decimal, abrem direto no Excel/Word)
  - figuras (PNG 300 dpi, prontas para o artigo)
  - RESULTADOS.md com todas as tabelas
"""

from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd
from scipy import signal, stats

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

BASE = Path(__file__).resolve().parent
DADOS = BASE / "dados"
RES = BASE / "resultados"

# ---- Parâmetros dos métodos (iguais aos do firmware) ----
ALFA = 0.1            # M2: EMA vetorial do VITAL (ALFA_GRAVIDADE)
JANELA_MM = 20        # M3: média móvel vetorial (0,4 s a 50 Hz)
RAZAO_Q_R = 0.01      # M4: Kalman 1D, q = r/100 -> ganho em regime ~0,095 (≈ EMA α=0,1)
DESCARTE_S = 1.0      # descarta o 1º segundo de cada janela estática
TOL_ACOMODACAO = 2.0  # graus, faixa do tempo de acomodação no degrau

METODOS = ["bruto", "ema", "media_movel", "kalman"]
NOMES = {
    "bruto": "M1 Bruto (sem filtro)",
    "ema": "M2 EMA α=0,1 (VITAL)",
    "media_movel": "M3 Média móvel N=20",
    "kalman": "M4 Kalman 1D",
}
CORES = {"bruto": "#2a78d6", "ema": "#eb6834", "media_movel": "#1baf7a", "kalman": "#eda100"}
CORES_MODO = {"novo": "#2a78d6", "reuso": "#eb6834"}
NOMES_MODO = {"novo": "Conexão nova a cada envio (VITAL)", "reuso": "Conexão persistente (keep-alive)"}
TXT1, TXT2, GRADE = "#0b0b0b", "#52514e", "#e4e3df"

plt.rcParams.update({
    "savefig.dpi": 300, "font.size": 9, "axes.titlesize": 10, "axes.titlecolor": TXT1,
    "axes.edgecolor": GRADE, "axes.labelcolor": TXT2, "xtick.color": TXT2, "ytick.color": TXT2,
    "axes.grid": True, "grid.color": GRADE, "grid.linewidth": 0.6, "grid.linestyle": "-",
    "axes.axisbelow": True, "axes.spines.top": False, "axes.spines.right": False,
    "legend.frameon": False, "legend.labelcolor": TXT1, "lines.linewidth": 1.5,
    "lines.solid_capstyle": "round", "figure.facecolor": "white", "axes.facecolor": "white",
})


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------

def mais_recente(padrao):
    arquivos = sorted(DADOS.glob(padrao))
    return arquivos[-1] if arquivos else None


def fmt(x, casas=2):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "–"
    return f"{x:.{casas}f}".replace(".", ",")


def fmt_p(p):
    return "p < 0,001" if p < 0.001 else f"p = {fmt(p, 3)}"


def media_dp(serie, casas=3):
    return f"{fmt(serie.mean(), casas)} ± {fmt(serie.std(ddof=1), casas)}"


def tabela_md(df, casas=None):
    casas = casas or {}
    cab = "| " + " | ".join(df.columns) + " |"
    sep = "|" + "|".join("---" for _ in df.columns) + "|"
    linhas = []
    for _, row in df.iterrows():
        cel = []
        for c in df.columns:
            v = row[c]
            if isinstance(v, (float, np.floating)):
                cel.append(fmt(float(v), casas.get(c, 2)))
            else:
                cel.append(str(v))
        linhas.append("| " + " | ".join(cel) + " |")
    return "\n".join([cab, sep, *linhas])


def salvar_tabela(df, nome):
    df.to_csv(RES / f"{nome}.csv", sep=";", decimal=",", index=False, encoding="utf-8-sig")


def salvar_figura(fig, nome):
    fig.savefig(RES / f"{nome}.png", bbox_inches="tight")
    plt.close(fig)


def angulo(v, ref):
    v = np.asarray(v, float)
    ref = np.asarray(ref, float)
    cos = (v @ ref) / (np.linalg.norm(v, axis=1) * np.linalg.norm(ref))
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def filtro_ema(v):
    zi = (1 - ALFA) * v[0]  # 1ª saída = 1ª amostra, como no firmware
    return np.column_stack([
        signal.lfilter([ALFA], [1, -(1 - ALFA)], v[:, k], zi=[zi[k]])[0] for k in range(3)
    ])


def filtro_mm(v):
    pad = np.vstack([np.repeat(v[:1], JANELA_MM - 1, axis=0), v])  # buffer pré-preenchido
    nucleo = np.ones(JANELA_MM) / JANELA_MM
    return np.column_stack([np.convolve(pad[:, k], nucleo, mode="valid") for k in range(3)])


def filtro_kalman(z, q, r):
    x, p = z[0], 1.0
    saida = np.empty_like(z)
    for i, zi in enumerate(z):
        p += q
        k = p / (p + r)
        x += k * (zi - x)
        p *= 1 - k
        saida[i] = x
    return saida


def angulos_por_metodo(v, refs, r_kalman):
    """refs: vetor de referência por amostra (n,3). Retorna dict metodo -> ângulo (graus)."""
    def ang(vv):
        cos = np.sum(vv * refs, axis=1) / (np.linalg.norm(vv, axis=1) * np.linalg.norm(refs, axis=1))
        return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))

    bruto = ang(v)
    return {
        "bruto": bruto,
        "ema": ang(filtro_ema(v)),
        "media_movel": ang(filtro_mm(v)),
        "kalman": filtro_kalman(bruto, RAZAO_Q_R * r_kalman, r_kalman),
    }


# ---------------------------------------------------------------------------
# Ensaio 1: inclinação estática
# ---------------------------------------------------------------------------

def analisar_inclinacao(md):
    arq = mais_recente("inclinacao_*.csv")
    if arq is None:
        md.append("## 1. Inclinação estática\n\n_Sem dados ainda (rode `coletar.py inclinacao`)._\n")
        return None

    df = pd.read_csv(arq)
    t = df["t_ms"].to_numpy(float) / 1000.0
    v = df[["ax", "ay", "az"]].to_numpy(float)
    rotulado = df["rep"].notna().to_numpy()

    # janelas (rep, ângulo nominal), descartando o 1º segundo
    janelas = []
    for (rep, nominal), g in df[rotulado].groupby(["rep", "ang_nominal"]):
        idx = g.index.to_numpy()
        idx = idx[t[idx] >= t[idx].min() + DESCARTE_S]
        janelas.append({"rep": int(rep), "nominal": float(nominal),
                        "app": float(g["ang_app"].iloc[0]), "idx": idx})
    jan = pd.DataFrame(janelas)
    nominal_zero = jan["nominal"].min()

    # referência por repetição = média do vetor bruto na janela de 0° (equivale ao CALIBRAR)
    ref_rep, app0_rep = {}, {}
    for rep, g in jan.groupby("rep"):
        j0 = g[g["nominal"] == nominal_zero].iloc[0]
        ref_rep[rep] = v[j0["idx"]].mean(axis=0)
        app0_rep[rep] = j0["app"]
    jan["ang_ref"] = jan.apply(lambda j: j["app"] - app0_rep[j["rep"]], axis=1)

    # cada amostra usa a referência da repetição em que está (transições: a mais próxima)
    rep_amostra = df["rep"].ffill().bfill().astype(int).to_numpy()
    refs = np.vstack([ref_rep[r] for r in rep_amostra])

    # r do Kalman = variância do ângulo bruto parado (janelas >= 15°, sem dobra em 0°)
    bruto_tmp = angulo(v, [0, 0, 1])  # só para variância local; a referência não importa
    variancias = []
    for _, j in jan[jan["nominal"] >= 15].iterrows():
        a = angulo(v[j["idx"]], ref_rep[j["rep"]])
        variancias.append(np.var(a, ddof=1))
    r_kalman = float(np.mean(variancias)) if variancias else float(np.var(bruto_tmp))

    angs = angulos_por_metodo(v, refs, r_kalman)

    # métricas por janela e método
    linhas = []
    erros_por_metodo = {m: [] for m in METODOS}
    for _, j in jan.iterrows():
        for m in METODOS:
            med = angs[m][j["idx"]]
            e = med - j["ang_ref"]
            erros_por_metodo[m].append(e)
            linhas.append({"metodo": m, "rep": j["rep"], "nominal": j["nominal"], "ang_ref": j["ang_ref"],
                           "media": med.mean(), "vies": e.mean(), "desvio": e.std(ddof=1),
                           "mae": np.abs(e).mean(), "rmse": np.sqrt((e ** 2).mean()),
                           "emax": np.abs(e).max(), "n": len(e)})
    por_janela = pd.DataFrame(linhas)

    # resumo por método
    resumo = []
    for m in METODOS:
        e = np.concatenate(erros_por_metodo[m])
        pj = por_janela[por_janela["metodo"] == m]
        reg = stats.linregress(pj["ang_ref"], pj["media"])
        repet = pj.groupby("nominal")["vies"].std(ddof=1).mean()
        resumo.append({
            "Método": NOMES[m], "Viés (°)": e.mean(), "MAE (°)": np.abs(e).mean(),
            "RMSE (°)": np.sqrt((e ** 2).mean()), "Erro máx. (°)": np.abs(e).max(),
            "Ruído σ (°)": pj["desvio"].mean(), "Repetibilidade (°)": repet,
            "Inclinação reta": reg.slope, "R²": reg.rvalue ** 2,
        })
    resumo = pd.DataFrame(resumo)

    # MAE por ângulo nominal
    por_angulo = (por_janela.groupby(["nominal", "metodo"])
                  .apply(lambda g: pd.Series({"mae": g["mae"].mean(), "rmse": np.sqrt((g["rmse"] ** 2).mean())}),
                         include_groups=False)
                  .reset_index())
    tab_angulo = por_angulo.pivot(index="nominal", columns="metodo", values="mae")[METODOS].reset_index()
    tab_angulo.columns = ["Ângulo nominal (°)"] + [NOMES[m] for m in METODOS]

    # testes estatísticos: Friedman (4 métodos, blocos = janelas) e Wilcoxon de cada método vs. EMA
    mae_mat = por_janela.pivot_table(index=["rep", "nominal"], columns="metodo", values="mae")[METODOS]
    fr = stats.friedmanchisquare(*[mae_mat[m] for m in METODOS])
    wil = []
    for m in ["bruto", "media_movel", "kalman"]:
        w = stats.wilcoxon(mae_mat[m], mae_mat["ema"])
        wil.append((m, w.statistic, w.pvalue))
    ordem = np.argsort([p for _, _, p in wil])
    p_holm = [0.0] * len(wil)
    acumulado = 0.0
    for pos, i in enumerate(ordem):
        acumulado = max(acumulado, min(1.0, wil[i][2] * (len(wil) - pos)))
        p_holm[i] = acumulado

    # taxa de amostragem efetiva (o envio HTTP bloqueia o loop)
    dt = np.diff(t) * 1000
    duracao = t[-1] - t[0]
    amostragem = {
        "taxa_media_hz": (len(t) - 1) / duracao, "dt_mediano_ms": np.median(dt),
        "lacunas": int((dt > 40).sum()), "lacuna_max_ms": dt.max(),
        "tempo_em_lacuna_pct": dt[dt > 40].sum() / (duracao * 1000) * 100, "duracao_s": duracao,
    }

    salvar_tabela(resumo, "inclinacao_resumo")
    salvar_tabela(tab_angulo, "inclinacao_mae_por_angulo")
    salvar_tabela(por_janela, "inclinacao_por_janela")

    # ---- Figura: MAE por ângulo ----
    fig, ax = plt.subplots(figsize=(6.5, 3.2))
    nominais = sorted(por_angulo["nominal"].unique())
    x = np.arange(len(nominais))
    larg = 0.19
    for k, m in enumerate(METODOS):
        valores = [por_angulo[(por_angulo["nominal"] == a) & (por_angulo["metodo"] == m)]["mae"].iloc[0]
                   for a in nominais]
        ax.bar(x + (k - 1.5) * (larg + 0.015), valores, width=larg, color=CORES[m], label=NOMES[m])
    ax.set_xticks(x, [f"{a:g}°" for a in nominais])
    ax.set_xlabel("Ângulo de referência (nominal)")
    ax.set_ylabel("Erro absoluto médio (°)")
    ax.set_title("Erro de inclinação por método e ângulo", loc="left")
    ax.grid(axis="x", visible=False)
    ax.legend(ncol=2, fontsize=8, loc="upper left", bbox_to_anchor=(0, -0.2))
    salvar_figura(fig, "fig1_inclinacao_mae_por_angulo")

    # ---- Figura: ruído em repouso (janela de 45°, ou a mais próxima) ----
    alvo = min(nominais, key=lambda a: abs(a - 45))
    j = jan[(jan["rep"] == jan["rep"].min()) & (jan["nominal"] == alvo)].iloc[0]
    tt = t[j["idx"]] - t[j["idx"]][0]
    fig, ax = plt.subplots(figsize=(6.5, 2.8))
    for m in METODOS:
        ax.plot(tt, angs[m][j["idx"]] - j["ang_ref"], color=CORES[m], label=NOMES[m],
                linewidth=0.9 if m == "bruto" else 1.5)
    ax.axhline(0, color=TXT2, linewidth=0.8)
    ax.set_xlabel("Tempo (s)")
    ax.set_ylabel("Erro (°)")
    ax.set_title(f"Sinal em repouso a {alvo:g}°: erro de cada método ao longo do tempo", loc="left")
    ax.legend(ncol=2, fontsize=8, loc="upper left", bbox_to_anchor=(0, -0.22))
    salvar_figura(fig, "fig2_inclinacao_ruido_repouso")

    # ---- Markdown ----
    md.append("## 1. Inclinação estática (LIS3DSH)\n")
    md.append(f"Arquivo: `{arq.name}` — {jan['rep'].nunique()} repetições × {len(nominais)} ângulos, "
              f"{int(por_janela['n'].sum() / len(METODOS))} amostras analisadas por método. "
              f"Ruído do ângulo bruto parado (r do Kalman): σ = {fmt(np.sqrt(r_kalman), 3)}°.\n")
    md.append("**Tabela 1 – Desempenho dos métodos de estimativa de inclinação**\n")
    md.append(tabela_md(resumo, {"Viés (°)": 3, "MAE (°)": 3, "RMSE (°)": 3, "Erro máx. (°)": 3,
                                 "Ruído σ (°)": 3, "Repetibilidade (°)": 3, "Inclinação reta": 4, "R²": 5}))
    md.append("\n**Tabela 2 – MAE (°) por ângulo nominal**\n")
    casas_ang = {c: 3 for c in tab_angulo.columns}
    casas_ang["Ângulo nominal (°)"] = 0
    md.append(tabela_md(tab_angulo, casas_ang))
    md.append(f"\n**Testes estatísticos (MAE por janela, n = {len(mae_mat)} janelas):** "
              f"Friedman χ² = {fmt(fr.statistic, 2)}, {fmt_p(fr.pvalue)}. "
              "Wilcoxon pareado vs. M2 (VITAL), p corrigido por Holm: " +
              "; ".join(f"{NOMES[m]}: {fmt_p(p_holm[i])}" for i, (m, _, _) in enumerate(wil)) + ".\n")
    md.append(f"**Amostragem efetiva:** {fmt(amostragem['taxa_media_hz'], 1)} Hz em média "
              f"(nominal 50 Hz); intervalo mediano {fmt(amostragem['dt_mediano_ms'], 1)} ms; "
              f"{amostragem['lacunas']} lacunas > 40 ms (máx. {fmt(amostragem['lacuna_max_ms'], 0)} ms), "
              f"{fmt(amostragem['tempo_em_lacuna_pct'], 1)}% do tempo.\n")
    md.append("![Figura 1](fig1_inclinacao_mae_por_angulo.png)\n")
    md.append("![Figura 2](fig2_inclinacao_ruido_repouso.png)\n")
    return {"r_kalman": r_kalman}


# ---------------------------------------------------------------------------
# Ensaio 2: degrau (tempo de resposta)
# ---------------------------------------------------------------------------

def primeiro_indice(cond):
    pos = np.flatnonzero(cond)
    return pos[0] if len(pos) else None


def analisar_degrau(md, r_kalman):
    arq = mais_recente("degrau_*.csv")
    if arq is None:
        md.append("## 2. Resposta ao degrau\n\n_Sem dados ainda (rode `coletar.py degrau`)._\n")
        return
    if r_kalman is None:
        r_kalman = 0.04  # σ ≈ 0,2° se ainda não houver ensaio estático

    df = pd.read_csv(arq)
    linhas, curvas = [], {}
    for rep, g in df[df["rep"].notna()].groupby("rep"):
        t = g["t_ms"].to_numpy(float) / 1000.0
        v = g[["ax", "ay", "az"]].to_numpy(float)
        ini = t < t[0] + 1.0
        ref = v[ini].mean(axis=0)
        angs = angulos_por_metodo(v, np.tile(ref, (len(v), 1)), r_kalman)
        bruto = angs["bruto"]
        final = np.median(bruto[t > t[-1] - 1.5])
        i_on = primeiro_indice(bruto > 0.1 * final)
        if i_on is None or final < 30:
            continue
        t_on = t[i_on]
        dt_trans = np.diff(t[(t >= t_on - 0.2) & (t <= t_on + 1.5)]) * 1000
        t50_bruto = t[primeiro_indice(bruto >= 0.5 * final)]
        curvas[int(rep)] = (t - t_on, angs, final)
        for m in METODOS:
            a = angs[m]
            i10, i50, i90 = (primeiro_indice(a >= f * final) for f in (0.1, 0.5, 0.9))
            fora = np.flatnonzero(np.abs(a - final) > TOL_ACOMODACAO)
            i_ac = fora[-1] + 1 if len(fora) and fora[-1] + 1 < len(a) else None
            linhas.append({
                "rep": int(rep), "metodo": m, "final": final,
                "subida_s": t[i90] - t[i10] if i10 is not None and i90 is not None else np.nan,
                "atraso_s": t[i50] - t50_bruto if i50 is not None else np.nan,
                "acomodacao_s": t[i_ac] - t_on if i_ac is not None else np.nan,
                "sobressinal": max(0.0, a[t > t_on].max() - final),
                "lacuna_max_ms": dt_trans.max() if len(dt_trans) else np.nan,
            })
    if not linhas:
        md.append("## 2. Resposta ao degrau\n\n_Nenhuma repetição válida encontrada._\n")
        return
    pr = pd.DataFrame(linhas)
    salvar_tabela(pr, "degrau_por_repeticao")

    resumo = []
    for m in METODOS:
        g = pr[pr["metodo"] == m]
        resumo.append({
            "Método": NOMES[m],
            "Subida 10–90% (s)": media_dp(g["subida_s"]),
            "Atraso vs. bruto (s)": media_dp(g["atraso_s"]),
            f"Acomodação ±{TOL_ACOMODACAO:g}° (s)": media_dp(g["acomodacao_s"]),
            "Sobressinal (°)": media_dp(g["sobressinal"], 2),
        })
    resumo = pd.DataFrame(resumo)
    salvar_tabela(resumo, "degrau_resumo")

    # figura: repetição com acomodação mediana do método do VITAL
    ema = pr[pr["metodo"] == "ema"].sort_values("acomodacao_s")
    rep_ex = int(ema.iloc[len(ema) // 2]["rep"])
    tt, angs, final = curvas[rep_ex]
    janela = (tt > -0.5) & (tt < 2.5)
    fig, ax = plt.subplots(figsize=(6.5, 3.0))
    ax.axhspan(final - TOL_ACOMODACAO, final + TOL_ACOMODACAO, color=GRADE, alpha=0.6, linewidth=0,
               label=f"Faixa ±{TOL_ACOMODACAO:g}° do valor final")
    for m in METODOS:
        ax.plot(tt[janela], angs[m][janela], color=CORES[m], label=NOMES[m],
                linewidth=0.9 if m == "bruto" else 1.5)
    ax.set_xlabel("Tempo desde o início do movimento (s)")
    ax.set_ylabel("Inclinação (°)")
    ax.set_title(f"Resposta ao degrau 0°→90° (repetição {rep_ex})", loc="left")
    ax.legend(ncol=2, fontsize=8, loc="upper left", bbox_to_anchor=(0, -0.2))
    salvar_figura(fig, "fig3_degrau_resposta")

    md.append("## 2. Resposta ao degrau (tempo de resposta)\n")
    md.append(f"Arquivo: `{arq.name}` — {pr['rep'].nunique()} repetições válidas de 0°→~90°. "
              f"Maior lacuna de amostragem durante as transições: {fmt(pr['lacuna_max_ms'].max(), 0)} ms.\n")
    md.append("**Tabela 3 – Resposta dinâmica (média ± desvio padrão entre repetições)**\n")
    md.append(tabela_md(resumo, {c: 3 for c in resumo.columns if c != "Método"}))
    md.append("\n![Figura 3](fig3_degrau_resposta.png)\n")


# ---------------------------------------------------------------------------
# Ensaio 3: comunicação Wi-Fi + Ensaio 4: DHT11
# ---------------------------------------------------------------------------

def analisar_wifi(md):
    arq = mais_recente("wifi_*.csv")
    if arq is None:
        md.append("## 3. Comunicação Wi-Fi\n\n_Sem dados ainda (rode `coletar.py wifi`)._\n")
        return
    w = pd.read_csv(arq)
    w = w[w["bloco"].notna()].copy()
    w["sucesso"] = w["codigo"] == 200
    w["t_min"] = (w["t_ms"] - w["t_ms"].iloc[0]) / 60000.0

    linhas, lat = [], {}
    for modo in ["novo", "reuso"]:
        g = w[w["modo"] == modo]
        if g.empty:
            continue
        ok = g[g["sucesso"]]["lat_ms"].to_numpy(float)
        lat[modo] = ok
        linhas.append({
            "Modo": NOMES_MODO[modo], "Envios": len(g), "Entregues": int(g["sucesso"].sum()),
            "Taxa de entrega (%)": g["sucesso"].mean() * 100,
            "Latência média (ms)": ok.mean(), "Desvio (ms)": ok.std(ddof=1),
            "Mediana (ms)": np.median(ok), "P95 (ms)": np.percentile(ok, 95), "Máx. (ms)": ok.max(),
        })
    tab = pd.DataFrame(linhas)
    salvar_tabela(tab, "wifi_resumo")

    texto_teste = ""
    if len(lat) == 2:
        mw = stats.mannwhitneyu(lat["novo"], lat["reuso"], alternative="two-sided")
        falhas = [[int((~w[w["modo"] == m]["sucesso"]).sum()), int(w[w["modo"] == m]["sucesso"].sum())]
                  for m in ["novo", "reuso"]]
        fisher = stats.fisher_exact(falhas)
        reducao = (1 - np.median(lat["reuso"]) / np.median(lat["novo"])) * 100
        texto_teste = (f"Mann-Whitney U (latência): U = {fmt(mw.statistic, 0)}, {fmt_p(mw.pvalue)}; "
                       f"redução da mediana com conexão persistente: {fmt(reducao, 1)}%. "
                       f"Teste exato de Fisher (taxa de entrega): {fmt_p(fisher.pvalue)}.")

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(7.0, 2.9), gridspec_kw={"width_ratios": [1.6, 1]})
    for modo in lat:
        g = w[(w["modo"] == modo) & w["sucesso"]]
        a1.plot(g["t_min"], g["lat_ms"], "o", markersize=2.5, color=CORES_MODO[modo], label=NOMES_MODO[modo])
        x = np.sort(lat[modo])
        a2.plot(x, np.arange(1, len(x) + 1) / len(x), color=CORES_MODO[modo], label=NOMES_MODO[modo])
    falhas_g = w[~w["sucesso"]]
    if not falhas_g.empty:
        a1.plot(falhas_g["t_min"], np.full(len(falhas_g), 0), "x", color=TXT1, markersize=4, label="Falha")
    a1.set_xlabel("Tempo de ensaio (min)")
    a1.set_ylabel("Latência do POST (ms)")
    a1.set_title("Latência de cada envio", loc="left")
    a2.set_xlabel("Latência (ms)")
    a2.set_ylabel("Fração acumulada")
    a2.set_title("Distribuição acumulada", loc="left")
    a1.legend(fontsize=8, loc="upper left", bbox_to_anchor=(0, -0.22), ncol=2)
    fig.tight_layout()
    salvar_figura(fig, "fig4_wifi_latencia")

    md.append("## 3. Comunicação Wi-Fi (HTTP)\n")
    dur_bloco = w.groupby("bloco")["t_min"].agg(lambda t: t.max() - t.min()).median() + 0.05  # + 1 intervalo
    modo_bloco = w.groupby("bloco")["modo"].agg(lambda m: m.mode().iloc[0])  # modo predominante
    n_blocos = {m: int((modo_bloco == m).sum()) for m in ["novo", "reuso"]}
    md.append(f"Arquivo: `{arq.name}` — blocos alternados de ~{fmt(dur_bloco, 0)} min entre os dois modos "
              f"({n_blocos['novo']} com conexão nova, {n_blocos['reuso']} com conexão persistente), "
              f"envio a cada 3 s, duração {fmt(w['t_min'].iloc[-1], 1)} min.\n")
    md.append("**Tabela 4 – Desempenho da comunicação**\n")
    md.append(tabela_md(tab, {"Taxa de entrega (%)": 2, "Latência média (ms)": 1, "Desvio (ms)": 1,
                              "Mediana (ms)": 1, "P95 (ms)": 1, "Máx. (ms)": 1}))
    md.append(f"\n{texto_teste}\n")
    md.append("![Figura 4](fig4_wifi_latencia.png)\n")


def analisar_dht(md):
    arq = mais_recente("dht_*.csv")
    if arq is None:
        md.append("## 4. DHT11\n\n_Sem dados ainda (coletado junto com o ensaio de Wi-Fi)._\n")
        return
    d = pd.read_csv(arq)
    d["t_min"] = (d["t_ms"] - d["t_ms"].iloc[0]) / 60000.0
    taxa_ok = d["ok"].mean() * 100
    v = d[d["ok"] == 1].reset_index(drop=True)

    linhas = []
    fig, eixos = plt.subplots(2, 1, figsize=(6.5, 4.2), sharex=True)
    for ax, var, un in zip(eixos, ["temperatura", "umidade"], ["°C", "%UR"]):
        x = v[var].astype(float)
        mm = x.rolling(5, min_periods=1).mean()
        tendencia = x.rolling(61, center=True, min_periods=15).mean()
        dif = x.diff().abs()
        for nome, serie in [("Bruto", x), ("Média móvel N=5", mm)]:
            linhas.append({
                "Grandeza": f"{var.capitalize()} ({un})", "Método": nome,
                "Média": serie.mean(), "Mín.": serie.min(), "Máx.": serie.max(),
                "Ruído σ (sem tendência)": (serie - tendencia).std(ddof=1),
                "Variação média entre leituras": serie.diff().abs().mean(),
            })
        resol = dif[dif > 0].min()
        linhas[-2]["Resolução observada"] = resol
        linhas[-1]["Resolução observada"] = np.nan
        ax.plot(v["t_min"], x, "o", markersize=2, color=CORES["bruto"], label="Bruto")
        ax.plot(v["t_min"], mm, color=CORES["ema"], label="Média móvel N=5")
        ax.set_ylabel(f"{var.capitalize()} ({un})")
    eixos[0].set_title("DHT11 ao longo do ensaio", loc="left")
    eixos[1].set_xlabel("Tempo (min)")
    eixos[1].legend(fontsize=8, loc="upper left", bbox_to_anchor=(0, -0.3), ncol=2)
    fig.tight_layout()
    salvar_figura(fig, "fig5_dht11")

    tab = pd.DataFrame(linhas)
    salvar_tabela(tab, "dht11_resumo")
    md.append("## 4. DHT11 (temperatura e umidade)\n")
    md.append(f"Arquivo: `{arq.name}` — {len(d)} tentativas de leitura em {fmt(d['t_min'].iloc[-1], 1)} min; "
              f"taxa de leituras válidas: {fmt(taxa_ok, 2)}%. Sem instrumento de referência: a exatidão "
              "considerada é a do fabricante (±2 °C e ±5 %UR); avaliam-se estabilidade e ruído.\n")
    md.append("**Tabela 5 – Estabilidade das leituras do DHT11**\n")
    md.append(tabela_md(tab, {c: 2 for c in tab.columns}))
    md.append("\n![Figura 5](fig5_dht11.png)\n")


def pressao_saturacao(t):
    """Pressão de vapor de saturação (hPa), fórmula de Magnus."""
    return 6.112 * np.exp(17.62 * t / (243.12 + t))


def curva_aquecimento(t, t0, dt, tau):
    return t0 + dt * (1 - np.exp(-t / tau))


def analisar_aquecimento(md):
    arquivos = sorted(DADOS.glob("aquecimento_*.csv"))
    md.append("## 5. Autoaquecimento do DHT11 (partida a frio)\n")
    if not arquivos:
        md.append("_Sem dados ainda (`coletar.py aquecimento`)._\n")
        return
    from scipy.optimize import curve_fit

    # um ensaio por condição (o mais recente)
    por_condicao = {}
    for arq in arquivos:
        d = pd.read_csv(arq)
        cond = d.loc[d["fase"] == "aquecimento", "condicao"]
        if len(cond):
            por_condicao[cond.iloc[0]] = (arq, d)

    linhas, curvas = [], []
    for cond, (arq, d) in por_condicao.items():
        d = d[d["ok"] == 1].copy()
        d[["temperatura", "umidade"]] = d[["temperatura", "umidade"]].astype(float)
        meta = arq.with_suffix(".json")
        info = pd.read_json(meta, typ="series") if meta.exists() else pd.Series(dtype=object)
        desligado = info.get("minutos_desligado", np.nan)
        energia = info.get("modo_energia") or "–"

        antes = d[d["fase"] == "antes"]
        aq = d[d["fase"] == "aquecimento"].copy()
        aq["t_min"] = aq["t_ms"].astype(float) / 60000.0
        inicio = aq[aq["t_min"] <= 0.5]
        if len(inicio) < 3:
            inicio = aq.head(5)
        if len(inicio) == 0 or aq["t_min"].iloc[-1] < 10:
            continue
        t_amb, ur_amb = inicio["temperatura"].mean(), inicio["umidade"].mean()
        fim = aq[aq["t_min"] >= aq["t_min"].iloc[-1] - 5]
        t_fim, ur_fim = fim["temperatura"].mean(), fim["umidade"].mean()
        ur_corr = ur_fim * pressao_saturacao(t_fim) / pressao_saturacao(t_amb)
        try:
            p, _ = curve_fit(curva_aquecimento, aq["t_min"], aq["temperatura"],
                             p0=[t_amb, t_fim - t_amb + 0.1, 10], bounds=([0, -5, 0.3], [60, 30, 180]))
        except RuntimeError:
            p = [np.nan, np.nan, np.nan]
        curvas.append((cond, aq, t_amb, p))

        if len(antes):
            cond_antes = antes["condicao"].iloc[0]
            t_ant = antes["temperatura"].median()
            ur_ant = antes["umidade"].median()
            linhas.append({
                "Montagem": f"{cond_antes} (regime, antes de desligar)", "Firmware": "–", "Desligado (min)": np.nan,
                "T ambiente (°C)": t_amb, "T sensor (°C)": t_ant, "ΔT (°C)": t_ant - t_amb,
                "ΔT∞ ajuste (°C)": np.nan, "τ (min)": np.nan, "UR ambiente (%)": ur_amb, "UR sensor (%)": ur_ant,
                "UR corrigida (%)": ur_ant * pressao_saturacao(t_ant) / pressao_saturacao(t_amb),
            })
        linhas.append({
            "Montagem": cond, "Firmware": energia, "Desligado (min)": desligado,
            "T ambiente (°C)": t_amb, "T sensor (°C)": t_fim, "ΔT (°C)": t_fim - t_amb,
            "ΔT∞ ajuste (°C)": p[1], "τ (min)": p[2], "UR ambiente (%)": ur_amb, "UR sensor (%)": ur_fim,
            "UR corrigida (%)": ur_corr,
        })

    if not linhas:
        md.append("_Ensaio incompleto (menos de 10 min gravados após a partida)._\n")
        return

    cores = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
    fig, ax = plt.subplots(figsize=(6.5, 3.4))
    for i, (cond, aq, t_amb, p) in enumerate(curvas):
        cor = cores[i % len(cores)]
        ax.plot(aq["t_min"], aq["temperatura"] - t_amb, "o", markersize=2, color=cor, alpha=0.6)
        if np.isfinite(p[2]):
            tt = np.linspace(0, aq["t_min"].iloc[-1], 200)
            ax.plot(tt, curva_aquecimento(tt, *p) - t_amb, color=cor,
                    label=f"{cond}: ΔT∞ = {fmt(p[1], 1)} °C, τ = {fmt(p[2], 1)} min")
    for lin in linhas:
        if "regime" in lin["Montagem"]:
            ax.axhline(lin["ΔT (°C)"], color=TXT2, linestyle=":", linewidth=1)
            ax.annotate(f"{lin['Montagem'].split(' (')[0]}: {fmt(lin['ΔT (°C)'], 1)} °C",
                        (0, lin["ΔT (°C)"]), xytext=(2, 3), textcoords="offset points", fontsize=8, color=TXT2)
    ax.set_xlabel("Tempo desde a partida (min)")
    ax.set_ylabel("T sensor − T ambiente (°C)")
    ax.set_title("Aquecimento do DHT11 causado pelo próprio VITAL", loc="left")
    ax.legend(fontsize=8, loc="lower right")
    fig.tight_layout()
    salvar_figura(fig, "fig6_aquecimento_dht11")

    tab = pd.DataFrame(linhas)
    salvar_tabela(tab, "aquecimento_dht11")
    md.append("Cada ensaio começa com o VITAL desligado tempo suficiente para esfriar: a média dos primeiros 30 s após "
              "ligar é tomada como temperatura do ambiente (sem termômetro de referência). ΔT é a diferença entre "
              "a média dos últimos 5 min e essa temperatura; ΔT∞ e τ vêm do ajuste T(t) = T₀ + ΔT∞·(1 − e^(−t/τ)). "
              "A linha \"regime, antes de desligar\" compara a leitura da placa quente na montagem anterior com o "
              "ambiente medido na partida seguinte (supõe ambiente estável no intervalo). \"UR corrigida\" recalcula "
              "a umidade relativa na temperatura do ambiente, mantendo a umidade absoluta (Magnus).\n")
    md.append("**Tabela 6 – Autoaquecimento do DHT11 por montagem**\n")
    md.append(tabela_md(tab, {"Desligado (min)": 0, "τ (min)": 1, "UR ambiente (%)": 0, "UR sensor (%)": 0,
                              "UR corrigida (%)": 0, **{c: 1 for c in tab.columns if "°C" in c}}))
    md.append("\n![Figura 6](fig6_aquecimento_dht11.png)\n")


def analisar_bench(md):
    arq = mais_recente("bench_*.csv")
    if arq is None:
        return
    b = pd.read_csv(arq)
    tab = pd.DataFrame({
        "Método": [NOMES[m] for m in b["metodo"]],
        "Tempo por amostra (µs)": b["us_min"].astype(float),
        "Memória de estado (bytes)": b["bytes_estado"].astype(int),
        "Uso da CPU a 50 Hz (%)": b["us_min"].astype(float) * 50 / 1e6 * 100,
    })
    salvar_tabela(tab, "custo_computacional")
    mhz = int(b["cpu_mhz"].dropna().iloc[0]) if "cpu_mhz" in b and b["cpu_mhz"].notna().any() else 240
    md.append(f"## 6. Custo computacional no ESP32 ({mhz} MHz)\n")
    md.append(f"Arquivo: `{arq.name}` — 20 000 iterações × 5 repetições por método (menor tempo).\n")
    md.append("**Tabela 7 – Custo de cada método**\n")
    md.append(tabela_md(tab, {"Tempo por amostra (µs)": 3, "Uso da CPU a 50 Hz (%)": 4}))
    md.append("")


def main():
    RES.mkdir(parents=True, exist_ok=True)
    md = ["# VITAL — Resultados da avaliação quantitativa\n",
          "Gerado automaticamente por `avaliacao/analisar.py` a partir dos dados em `avaliacao/dados/`.\n"]
    info = analisar_inclinacao(md)
    analisar_degrau(md, info["r_kalman"] if info else None)
    analisar_wifi(md)
    analisar_dht(md)
    analisar_aquecimento(md)
    analisar_bench(md)
    (RES / "RESULTADOS.md").write_text("\n".join(md), encoding="utf-8")
    print(f"Resultados em {RES}")


if __name__ == "__main__":
    main()
