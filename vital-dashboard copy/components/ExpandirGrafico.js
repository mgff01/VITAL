'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';

// Botão pequeno que fica no cabeçalho de cada gráfico.
export function BotaoExpandir({ titulo, onClick }) {
  return (
    <button
      type="button"
      className="vital-button vital-button-sm flex items-center"
      onClick={onClick}
      aria-label={`Expand chart: ${titulo}`}
      title="Expand"
    >
      <Maximize2 size={12} aria-hidden="true" />
    </button>
  );
}

// Gráfico em tela cheia: fecha com Esc, com o X ou clicando fora.
// `children` ocupa todo o espaço livre (use altura "100%" no gráfico).
export function PainelExpandido({ titulo, onFechar, acoes = null, children }) {
  const botaoFechar = useRef(null);

  useEffect(() => {
    const anterior = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    botaoFechar.current?.focus();

    function tecla(e) {
      if (e.key === 'Escape') {
        onFechar();
      }
    }
    window.addEventListener('keydown', tecla);
    return () => {
      window.removeEventListener('keydown', tecla);
      document.body.style.overflow = overflow;
      if (anterior instanceof HTMLElement) {
        anterior.focus();
      }
    };
  }, [onFechar]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/75 p-3 sm:p-8"
      onMouseDown={onFechar}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="corner-frame flex w-full max-w-[1400px] flex-col border border-line-bright bg-panel p-4 sm:p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="corner-bl" />
        <span className="corner-br" />
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="label-tracked text-ink">{titulo}</div>
          <div className="flex flex-wrap items-center gap-3">
            {acoes}
            <button
              ref={botaoFechar}
              type="button"
              className="vital-button vital-button-sm flex items-center gap-1.5"
              onClick={onFechar}
              aria-label="Close expanded chart"
            >
              <X size={12} aria-hidden="true" /> esc
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>,
    document.body
  );
}
