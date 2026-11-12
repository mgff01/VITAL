'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { Box, Crosshair, RotateCcw, Upload } from 'lucide-react';
import CornerFrame from '@/components/CornerFrame';
import { assinarRealtime } from '@/lib/realtimeCliente';

// Orientação a partir do acelerômetro: a gravidade medida (filtrada) diz
// pitch e roll. Giro em torno do eixo vertical (yaw) não é observável só
// com acelerômetro — o modelo fica sempre com o mesmo "norte".

const COR = {
  fundo: 0x111113,
  grade: 0x1e1e22,
  gradeForte: 0x2c2c32,
  ambar: 0xff7a1a,
  alerta: 0xff4433,
  tinta: '#E9E7E2',
  eixoX: 0xd95926,
  eixoY: 0x3987e5,
  eixoZ: 0x199e70,
};
const MODELOS_PADRAO = ['vital.glb', 'vital.gltf', 'vital.stl', 'vital.obj'];
const TAMANHO_ALVO = 8; // maior dimensão do modelo na cena
const SEM_STREAM_MS = 2000;
const CHAVE_MODO = 'vital3d.modo';
const CHAVE_REF = 'vital3d.referencia';
const CHAVE_ALINHAMENTO = 'vital3d.alinhamento';

// Eixos do sensor -> eixos da cena (three.js usa Y para cima):
// sensor X -> cena X, sensor Y -> cena -Z, sensor Z -> cena Y.
function sensorParaCena(x, y, z) {
  return new THREE.Vector3(x, z, -y);
}

function lerStorage(chave, padrao) {
  try {
    const valor = window.localStorage.getItem(chave);
    return valor ? JSON.parse(valor) : padrao;
  } catch (err) {
    return padrao;
  }
}

function gravarStorage(chave, valor) {
  try {
    window.localStorage.setItem(chave, JSON.stringify(valor));
  } catch (err) {
    // armazenamento bloqueado: segue sem lembrar a preferência
  }
}

function pitchRoll({ gx, gy, gz }) {
  return {
    pitch: (Math.atan2(-gx, Math.hypot(gy, gz)) * 180) / Math.PI,
    roll: (Math.atan2(gy, gz) * 180) / Math.PI,
  };
}

function anguloEntre(a, b) {
  return (a.angleTo(b) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

function material(cor, extra = {}) {
  return new THREE.MeshStandardMaterial({ color: cor, roughness: 0.7, metalness: 0.1, ...extra });
}

function criarModeloProcedural() {
  const grupo = new THREE.Group();
  const caixa = (l, a, p, mat, x = 0, y = 0, z = 0) => {
    const malha = new THREE.Mesh(new THREE.BoxGeometry(l, a, p), mat);
    malha.position.set(x, y, z);
    grupo.add(malha);
    return malha;
  };

  const pcb = caixa(8, 0.16, 5.4, material(0x2c3036));
  const bordas = new THREE.LineSegments(
    new THREE.EdgesGeometry(pcb.geometry),
    new THREE.LineBasicMaterial({ color: COR.ambar })
  );
  pcb.add(bordas);

  caixa(3.1, 0.3, 1.8, material(0x8b8b92, { metalness: 0.6, roughness: 0.35 }), -1.9, 0.23, 0); // ESP32-WROVER
  caixa(0.7, 0.1, 1.8, material(0x24272c), -3.75, 0.13, 0); // antena
  caixa(7.2, 0.25, 0.25, material(0x0d0d10), 0, 0.2, 2.45); // barras de pinos
  caixa(7.2, 0.25, 0.25, material(0x0d0d10), 0, 0.2, -2.45);
  caixa(0.8, 0.3, 0.75, material(0xb8b8be, { metalness: 0.7, roughness: 0.3 }), 3.75, 0.23, 0); // USB
  caixa(1.6, 0.1, 1.6, material(0x1d3a5f), 1.6, 0.13, 0); // placa do LIS3DSH
  caixa(0.42, 0.12, 0.42, material(COR.ambar, { emissive: COR.ambar, emissiveIntensity: 0.3 }), 1.6, 0.24, 0);
  caixa(1.2, 0.55, 1.55, material(0x2b6cb0), 2.9, 0.36, -1.4); // DHT11

  return { objeto: grupo, bordas, tamanho: new THREE.Vector3(8, 0.6, 5.4), nome: 'VITAL board (built-in)' };
}

function normalizarModelo(objeto) {
  const caixa = new THREE.Box3().setFromObject(objeto);
  const tamanho = caixa.getSize(new THREE.Vector3());
  const centro = caixa.getCenter(new THREE.Vector3());
  const escala = TAMANHO_ALVO / Math.max(tamanho.x, tamanho.y, tamanho.z, 1e-6);
  objeto.position.sub(centro);
  const grupo = new THREE.Group();
  grupo.add(objeto);
  grupo.scale.setScalar(escala);
  return { objeto: grupo, tamanho: tamanho.multiplyScalar(escala) };
}

async function carregarModelo(url, extensao) {
  let objeto;
  if (extensao === 'glb' || extensao === 'gltf') {
    objeto = (await new GLTFLoader().loadAsync(url)).scene;
  } else if (extensao === 'stl') {
    const geometria = await new STLLoader().loadAsync(url);
    geometria.computeVertexNormals();
    objeto = new THREE.Mesh(geometria, material(0x9a9aa2, { metalness: 0.25, roughness: 0.55 }));
  } else if (extensao === 'obj') {
    objeto = await new OBJLoader().loadAsync(url);
    objeto.traverse((filho) => {
      if (filho.isMesh) {
        filho.material = material(0x9a9aa2, { metalness: 0.25, roughness: 0.55 });
      }
    });
  } else {
    throw new Error(`Formato .${extensao} não suportado (use GLB, GLTF, STL ou OBJ).`);
  }
  return normalizarModelo(objeto);
}

function criarRotulo(texto) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 38px monospace';
  ctx.fillStyle = COR.tinta;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(texto, 32, 34);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true })
  );
  sprite.scale.set(0.7, 0.7, 0.7);
  sprite.renderOrder = 10;
  return sprite;
}

// Setas desenhadas por cima do modelo: vão para a fila de transparentes
// (renderizada depois dos opacos) e ignoram o teste de profundidade.
function sempreNaFrente(seta) {
  for (const parte of [seta.line, seta.cone]) {
    parte.material.transparent = true;
    parte.material.depthTest = false;
    parte.material.depthWrite = false;
    parte.renderOrder = 10;
  }
}

function criarEixos() {
  const grupo = new THREE.Group();
  const origem = new THREE.Vector3(1.6, 0.35, 0); // sobre o chip do acelerômetro
  const eixos = [
    ['X', sensorParaCena(1, 0, 0), COR.eixoX],
    ['Y', sensorParaCena(0, 1, 0), COR.eixoY],
    ['Z', sensorParaCena(0, 0, 1), COR.eixoZ],
  ];
  for (const [nome, direcao, cor] of eixos) {
    const seta = new THREE.ArrowHelper(direcao, origem, 2.4, cor, 0.45, 0.25);
    sempreNaFrente(seta);
    grupo.add(seta);
    const rotulo = criarRotulo(nome);
    rotulo.position.copy(origem).addScaledVector(direcao, 2.95);
    grupo.add(rotulo);
  }
  return grupo;
}

function descartar(objeto) {
  objeto.traverse((filho) => {
    filho.geometry?.dispose?.();
    const materiais = Array.isArray(filho.material) ? filho.material : [filho.material];
    materiais.forEach((m) => {
      m?.map?.dispose?.();
      m?.dispose?.();
    });
  });
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export default function Vital3D({ leitura, limiarImpacto }) {
  const containerRef = useRef(null);
  const motorRef = useRef(null); // tudo do three.js fica aqui (fora do estado do React)
  const leituraRef = useRef(leitura);
  const limiarRef = useRef(limiarImpacto ?? 0.5);
  const inputArquivoRef = useRef(null);

  const [modo, setModo] = useState('absoluto');
  const [temReferencia, setTemReferencia] = useState(false);
  const [hud, setHud] = useState({ fonte: 'nenhuma', hz: 0, pitch: null, roll: null, tilt: null, dinamica: null });
  const [aviso, setAviso] = useState(null); // último impacto
  const [nomeModelo, setNomeModelo] = useState('');
  const [modeloCustom, setModeloCustom] = useState(false);
  const [erro, setErro] = useState(null);

  leituraRef.current = leitura;
  limiarRef.current = limiarImpacto ?? 0.5;

  // ---- cena, câmera, laço de animação ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (err) {
      setErro('WebGL is not available in this browser.');
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const cena = new THREE.Scene();
    cena.background = new THREE.Color(COR.fundo);
    cena.fog = new THREE.Fog(COR.fundo, 28, 60);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    const POSICAO_CAMERA = new THREE.Vector3(10, 8, 12);
    camera.position.copy(POSICAO_CAMERA);

    const controles = new OrbitControls(camera, renderer.domElement);
    controles.enableDamping = true;
    controles.enablePan = false;
    controles.minDistance = 7;
    controles.maxDistance = 40;

    cena.add(new THREE.HemisphereLight(0xdedcd6, 0x2a2a30, 1.2));
    const sol = new THREE.DirectionalLight(0xffffff, 1.6);
    sol.position.set(6, 12, 8);
    cena.add(sol);
    const contraluz = new THREE.DirectionalLight(0xff9a50, 0.35);
    contraluz.position.set(-8, 4, -6);
    cena.add(contraluz);

    const grade = new THREE.GridHelper(44, 22, COR.gradeForte, COR.grade);
    grade.position.y = -5.2;
    cena.add(grade);

    // pivô = orientação medida; alinhamento = correção do modelo do usuário
    const pivo = new THREE.Group();
    const alinhamento = new THREE.Group();
    pivo.add(alinhamento);
    cena.add(pivo);
    const eixos = criarEixos();
    pivo.add(eixos);

    const anel = new THREE.Mesh(
      new THREE.RingGeometry(4.2, 4.35, 72),
      new THREE.MeshBasicMaterial({ color: COR.alerta, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    anel.rotation.x = -Math.PI / 2;
    cena.add(anel);

    const motor = {
      renderer,
      cena,
      camera,
      controles,
      pivo,
      alinhamento,
      anel,
      modelo: null,
      bordas: null,
      alvo: new THREE.Quaternion(),
      referencia: null, // vetor de referência (cena) no modo relativo
      modo: 'absoluto',
      ultimaAmostra: null,
      ultimaAmostraEm: 0,
      contagem: [],
      pulso: 0,
      setas: [],
      POSICAO_CAMERA,
    };
    motorRef.current = motor;
    if (process.env.NODE_ENV !== 'production') {
      window.__vital3d = motor; // inspeção pelo console em modo dev
    }

    const ajustarTamanho = () => {
      const { clientWidth: largura, clientHeight: altura } = container;
      if (largura === 0 || altura === 0) {
        return;
      }
      renderer.setSize(largura, altura, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = largura / altura;
      camera.updateProjectionMatrix();
    };
    const observador = new ResizeObserver(ajustarTamanho);
    observador.observe(container);
    ajustarTamanho();

    let quadro = 0;
    let anterior = performance.now();
    const animar = (agora) => {
      const dt = Math.min(0.1, (agora - anterior) / 1000);
      anterior = agora;

      pivo.quaternion.slerp(motor.alvo, 1 - Math.exp(-dt * 12));

      if (motor.pulso > 0) {
        motor.pulso = Math.max(0, motor.pulso - dt * 1.4);
        anel.material.opacity = motor.pulso * 0.9;
        anel.scale.setScalar(1 + (1 - motor.pulso) * 0.6);
        if (motor.bordas) {
          motor.bordas.material.color.setHex(motor.pulso > 0.05 ? COR.alerta : COR.ambar);
        }
      }

      motor.setas = motor.setas.filter((item) => {
        item.vida -= dt / 3;
        if (item.vida <= 0) {
          pivo.remove(item.seta);
          // a geometria do ArrowHelper é compartilhada com as setas dos eixos
          item.seta.line.material.dispose();
          item.seta.cone.material.dispose();
          return false;
        }
        item.seta.line.material.opacity = item.vida;
        item.seta.cone.material.opacity = item.vida;
        return true;
      });

      controles.update();
      renderer.render(cena, camera);
      quadro = requestAnimationFrame(animar);
    };
    quadro = requestAnimationFrame(animar);

    return () => {
      cancelAnimationFrame(quadro);
      observador.disconnect();
      controles.dispose();
      descartar(cena);
      renderer.dispose();
      renderer.domElement.remove();
      motorRef.current = null;
    };
  }, []);

  // ---- modelo: arquivo em /models ou procedural ----
  useEffect(() => {
    let cancelado = false;

    async function procurarModelo() {
      try {
        const res = await fetch('/api/model', { cache: 'no-store' });
        const { arquivo, alinhamento } = await res.json();
        return MODELOS_PADRAO.includes(arquivo) ? { arquivo, alinhamento } : { arquivo: null };
      } catch (err) {
        return { arquivo: null };
      }
    }

    (async () => {
      const { arquivo, alinhamento } = await procurarModelo();
      if (cancelado) {
        return;
      }
      if (arquivo) {
        try {
          const modelo = await carregarModelo(`/models/${arquivo}`, arquivo.split('.').pop().toLowerCase());
          if (!cancelado) {
            trocarModelo({ ...modelo, nome: arquivo }, true, alinhamento);
          }
          return;
        } catch (err) {
          setErro(`Could not load /models/${arquivo}: ${err.message}`);
        }
      }
      if (!cancelado) {
        trocarModelo(criarModeloProcedural(), false);
      }
    })();

    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // alinhamentoPadrao: [x, y, z] em graus, de public/models/vital.json
  function trocarModelo(modelo, custom, alinhamentoPadrao = [0, 0, 0]) {
    const motor = motorRef.current;
    if (!motor) {
      return;
    }
    if (motor.modelo) {
      motor.alinhamento.remove(motor.modelo);
      descartar(motor.modelo);
    }
    motor.modelo = modelo.objeto;
    motor.bordas = modelo.bordas ?? null;
    motor.alinhamento.add(modelo.objeto);

    // ajuste manual (botões Align) fica salvo por arquivo de modelo
    motor.chaveAlinhamento = `${CHAVE_ALINHAMENTO}:${modelo.nome}`;
    motor.alinhamentoPadrao = custom ? alinhamentoPadrao : [0, 0, 0];
    const rot = custom ? lerStorage(motor.chaveAlinhamento, motor.alinhamentoPadrao) : [0, 0, 0];
    motor.alinhamento.rotation.set(...rot.map((g) => (g * Math.PI) / 180));
    setNomeModelo(modelo.nome);
    setModeloCustom(custom);
  }

  // ---- preferências salvas (modo e referência) ----
  useEffect(() => {
    const motor = motorRef.current;
    const modoSalvo = lerStorage(CHAVE_MODO, 'absoluto');
    const ref = lerStorage(CHAVE_REF, null);
    if (motor && ref) {
      motor.referencia = sensorParaCena(ref.gx, ref.gy, ref.gz).normalize();
      setTemReferencia(true);
    }
    aplicarModo(modoSalvo === 'relativo' && ref ? 'relativo' : 'absoluto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function atualizarAlvo(g) {
    const motor = motorRef.current;
    if (!motor) {
      return;
    }
    const medido = sensorParaCena(g.gx, g.gy, g.gz);
    if (medido.lengthSq() < 0.01) {
      return; // queda livre / leitura inválida
    }
    medido.normalize();
    const alvoRef =
      motor.modo === 'relativo' && motor.referencia ? motor.referencia : new THREE.Vector3(0, 1, 0);
    motor.alvo.setFromUnitVectors(medido, alvoRef);
  }

  function aplicarModo(novo) {
    const motor = motorRef.current;
    if (motor) {
      motor.modo = novo;
      if (motor.ultimaAmostra) {
        atualizarAlvo(motor.ultimaAmostra);
      }
    }
    setModo(novo);
    gravarStorage(CHAVE_MODO, novo);
  }

  function definirZero() {
    const motor = motorRef.current;
    const g = motor?.ultimaAmostra;
    if (!g) {
      return;
    }
    motor.referencia = sensorParaCena(g.gx, g.gy, g.gz).normalize();
    gravarStorage(CHAVE_REF, { gx: g.gx, gy: g.gy, gz: g.gz });
    setTemReferencia(true);
    aplicarModo('relativo');
  }

  function resetarCamera() {
    const motor = motorRef.current;
    if (!motor) {
      return;
    }
    motor.camera.position.copy(motor.POSICAO_CAMERA);
    motor.controles.target.set(0, 0, 0);
    motor.controles.update();
  }

  function girarModelo(eixo) {
    const motor = motorRef.current;
    if (!motor) {
      return;
    }
    const padrao = motor.alinhamentoPadrao ?? [0, 0, 0];
    let novo;
    if (eixo === 'reset') {
      novo = padrao; // volta ao alinhamento do projeto (vital.json)
      try {
        window.localStorage.removeItem(motor.chaveAlinhamento);
      } catch (err) {
        // armazenamento bloqueado
      }
    } else {
      const atual = lerStorage(motor.chaveAlinhamento, padrao);
      novo = atual.map((g, i) => (i === eixo ? (g + 90) % 360 : g));
      gravarStorage(motor.chaveAlinhamento, novo);
    }
    motor.alinhamento.rotation.set(...novo.map((g) => (g * Math.PI) / 180));
  }

  async function abrirArquivo(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = '';
    if (!arquivo) {
      return;
    }
    const url = URL.createObjectURL(arquivo);
    try {
      const modelo = await carregarModelo(url, arquivo.name.split('.').pop().toLowerCase());
      trocarModelo({ ...modelo, nome: `${arquivo.name} (preview)` }, true);
      setErro(null);
    } catch (err) {
      setErro(err.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---- dados ao vivo (UDP -> SSE) ----
  useEffect(() => {
    const cancelarAmostras = assinarRealtime('amostra', (amostra) => {
      const motor = motorRef.current;
      if (!motor) {
        return;
      }
      motor.ultimaAmostra = amostra;
      motor.ultimaAmostraEm = performance.now();
      motor.contagem.push(motor.ultimaAmostraEm);
      atualizarAlvo(amostra);
      if (typeof amostra.dinamica === 'number' && amostra.dinamica >= limiarRef.current) {
        motor.pulso = 1;
      }
    });

    const cancelarImpactos = assinarRealtime('impacto', (impacto) => {
      const motor = motorRef.current;
      setAviso({ ...impacto, recebidoEm: Date.now() });
      if (!motor) {
        return;
      }
      motor.pulso = 1;
      const { x, y, z } = impacto.direcao ?? {};
      if ([x, y, z].every((v) => typeof v === 'number')) {
        const direcao = sensorParaCena(x, y, z);
        if (direcao.lengthSq() > 1e-6) {
          const comprimento = 2 + Math.min(impacto.picoG, 3) * 1.6;
          const seta = new THREE.ArrowHelper(direcao.normalize(), new THREE.Vector3(1.6, 0.35, 0), comprimento, COR.alerta, 0.6, 0.35);
          sempreNaFrente(seta);
          motor.pivo.add(seta);
          motor.setas.push({ seta, vida: 1 });
        }
      }
    });

    return () => {
      cancelarAmostras();
      cancelarImpactos();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- HUD (5x por segundo) e plano B pelo polling HTTP ----
  useEffect(() => {
    const id = setInterval(() => {
      const motor = motorRef.current;
      if (!motor) {
        return;
      }
      const agora = performance.now();
      motor.contagem = motor.contagem.filter((t) => agora - t <= 1000);
      const aoVivo = motor.ultimaAmostra && agora - motor.ultimaAmostraEm < SEM_STREAM_MS;

      let g = aoVivo ? motor.ultimaAmostra : null;
      let fonte = aoVivo ? 'ao-vivo' : 'nenhuma';
      const l = leituraRef.current;
      if (!g && l && [l.ax, l.ay, l.az].every((v) => typeof v === 'number')) {
        g = { gx: l.ax, gy: l.ay, gz: l.az, dinamica: l.pico, inclinacao: l.inclinacao };
        fonte = 'polling';
        atualizarAlvo(g);
      }

      if (!g) {
        setHud((h) => ({ ...h, fonte, hz: 0 }));
        return;
      }
      const medido = sensorParaCena(g.gx, g.gy, g.gz);
      const ref =
        motor.modo === 'relativo' && motor.referencia ? motor.referencia : new THREE.Vector3(0, 1, 0);
      setHud({
        fonte,
        hz: motor.contagem.length,
        ...pitchRoll(g),
        tilt: anguloEntre(medido, ref),
        dinamica: g.dinamica ?? null,
      });
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // o aviso de impacto some sozinho
  useEffect(() => {
    if (!aviso) {
      return undefined;
    }
    const id = setTimeout(() => setAviso(null), 5000);
    return () => clearTimeout(id);
  }, [aviso]);

  const fmt = (v, casas = 1) => (typeof v === 'number' ? v.toFixed(casas) : '--');
  const sinal = (v, casas = 1) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(casas)}` : '--');
  const limiar = limiarImpacto ?? 0.5;
  const fracaoDinamica = typeof hud.dinamica === 'number' ? Math.min(1, hud.dinamica / (limiar * 2)) : 0;
  const acimaLimiar = typeof hud.dinamica === 'number' && hud.dinamica >= limiar;

  const rotuloFonte = {
    'ao-vivo': `LIVE · ${hud.hz} Hz`,
    polling: 'POLLING · 3 s',
    nenhuma: 'NO DATA',
  }[hud.fonte];
  const corFonte = { 'ao-vivo': 'bg-signal', polling: 'bg-amber', nenhuma: 'bg-line-bright' }[hud.fonte];

  return (
    <>
      <CornerFrame active={hud.fonte === 'ao-vivo'} className="mb-3.5">
        <div className="relative h-[380px] sm:h-[520px] overflow-hidden">
          <div ref={containerRef} className="absolute inset-0" />

          {erro && (
            <div className="absolute inset-x-3 bottom-3 border border-alert bg-void/90 px-3 py-2 mono text-[11px] text-alert">
              {erro}
            </div>
          )}

          {/* HUD: fonte dos dados */}
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 border border-line bg-void/80 px-2.5 py-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${corFonte}`} />
            <span className="mono text-[11px] text-ink">{rotuloFonte}</span>
          </div>

          {/* HUD: ângulos */}
          <div className="pointer-events-none absolute right-3 top-3 border border-line bg-void/80 px-3 py-2 text-right">
            <div className="label-tracked text-ink-dim">{modo === 'relativo' ? 'tilt vs zero' : 'tilt vs level'}</div>
            <div className="mono font-semibold text-amber" style={{ fontSize: 28 }}>
              {fmt(hud.tilt)}°
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-left">
              <span className="label-tracked text-ink-dim">pitch</span>
              <span className="mono text-[13px] text-ink text-right">{sinal(hud.pitch)}°</span>
              <span className="label-tracked text-ink-dim">roll</span>
              <span className="mono text-[13px] text-ink text-right">{sinal(hud.roll)}°</span>
            </div>
          </div>

          {/* HUD: movimento brusco */}
          <div className="pointer-events-none absolute bottom-3 left-3 w-44 border border-line bg-void/80 px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="label-tracked text-ink-dim">motion</span>
              <span className={`mono text-[12px] ${acimaLimiar ? 'text-alert' : 'text-ink'}`}>{fmt(hud.dinamica, 3)} g</span>
            </div>
            <div className="relative mt-1.5 h-1.5 border border-line bg-void">
              <span
                className={`absolute inset-y-0 left-0 ${acimaLimiar ? 'bg-alert' : 'bg-amber'}`}
                style={{ width: `${fracaoDinamica * 100}%` }}
              />
              <span className="absolute -top-1 -bottom-1 left-1/2 w-px bg-ink-dim" title="impact threshold" />
            </div>
            <div className="mt-1 mono text-[10px] text-ink-dim">threshold {limiar.toFixed(2)} g (mid mark)</div>
          </div>

          {/* aviso de impacto */}
          {aviso && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 border border-alert bg-void/90 px-3 py-1.5 text-center">
              <div className="label-tracked text-alert">impact detected</div>
              <div className="mono text-[13px] text-ink">
                {aviso.picoG.toFixed(2)} g · {aviso.eixo ?? '--'}
                {aviso.saturado ? ' · ≥2 g' : ''}
              </div>
            </div>
          )}

          <div className="pointer-events-none absolute bottom-3 right-3 mono text-[10px] text-ink-dim">
            {nomeModelo} · drag to orbit
          </div>
        </div>

        {/* Controles */}
        <div className="flex flex-wrap items-center gap-2.5 border-t border-line p-3">
          <div className="flex" role="group" aria-label="Orientation reference">
            <button
              type="button"
              className="vital-button"
              aria-pressed={modo === 'absoluto'}
              onClick={() => aplicarModo('absoluto')}
            >
              Level
            </button>
            <button
              type="button"
              className="vital-button -ml-px"
              aria-pressed={modo === 'relativo'}
              onClick={() => aplicarModo('relativo')}
              disabled={!temReferencia}
              title="Uses the position saved with SET 3D ZERO"
            >
              Zeroed
            </button>
          </div>
          <button type="button" className="vital-button flex items-center gap-1.5" onClick={definirZero}>
            <Crosshair size={13} /> Set 3D zero
          </button>
          <button type="button" className="vital-button flex items-center gap-1.5" onClick={resetarCamera}>
            <RotateCcw size={13} /> Reset view
          </button>
          <button
            type="button"
            className="vital-button flex items-center gap-1.5"
            onClick={() => inputArquivoRef.current?.click()}
          >
            <Upload size={13} /> Load model
          </button>
          <input
            ref={inputArquivoRef}
            type="file"
            accept=".glb,.gltf,.stl,.obj"
            className="hidden"
            onChange={abrirArquivo}
          />
          {modeloCustom && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Align model">
              <Box size={13} className="text-ink-dim" />
              <span className="label-tracked text-ink-dim">align</span>
              {['X', 'Y', 'Z'].map((nome, i) => (
                <button key={nome} type="button" className="vital-button px-2.5" onClick={() => girarModelo(i)}>
                  {nome}+90°
                </button>
              ))}
              <button type="button" className="vital-button px-2.5" onClick={() => girarModelo('reset')}>
                Reset
              </button>
            </div>
          )}
        </div>
      </CornerFrame>

      <p className="mb-3.5 mono text-[11px] leading-relaxed text-ink-dim">
        Orientation comes from gravity measured by the accelerometer (20 Hz over UDP). It shows tilt (pitch/roll) but not
        rotation around the vertical axis (yaw) — that needs a gyroscope or magnetometer. Red arrows show the direction of
        detected impacts. To use your own model, put it in <span className="text-ink">vital-dashboard/public/models/</span>{' '}
        as vital.glb (or .gltf, .stl, .obj).
      </p>
    </>
  );
}
