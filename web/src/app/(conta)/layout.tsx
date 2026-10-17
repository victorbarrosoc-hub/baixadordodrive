import type { Viewport } from "next";

/** Barra do navegador e da Tela de Início na cor do fundo, clara ou escura (tema escuro em globals.css). */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfd" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/**
 * Telas de conta: marca data-tema="conta" para o tema escuro valer só aqui (a home continua clara).
 * `display: contents`: o invólucro não muda nada no layout.
 */
export default function LayoutConta({ children }: { children: React.ReactNode }) {
  return (
    <div data-tema="conta" className="contents">
      {children}
    </div>
  );
}
