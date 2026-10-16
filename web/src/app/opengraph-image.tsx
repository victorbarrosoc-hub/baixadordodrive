import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "SOBEDESCE: arquivos gigantes no seu Google Drive, do celular e do computador.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonte = (peso: number) => readFile(join(process.cwd(), `src/assets/og/inter-${peso}.woff`));

/**
 * Imagem de compartilhamento (WhatsApp, iMessage, redes). Composição centrada: no WhatsApp a prévia pequena corta
 * um quadrado do meio, e o ícone e o nome continuam inteiros. Feixes azuis descendo e violetas subindo ao fundo.
 */
export default async function OpengraphImage() {
  const [w500, w600, w700] = await Promise.all([fonte(500), fonte(600), fonte(700)]);
  // Feixes do fundo: x (px), altura e opacidade. Esquerda desce (azul), direita sobe (violeta).
  const feixes = [
    { x: 44, h: 300, o: 0.35, c: "#3D9CFF", desce: true },
    { x: 112, h: 420, o: 0.5, c: "#3D9CFF", desce: true },
    { x: 180, h: 240, o: 0.28, c: "#3D9CFF", desce: true },
    { x: 1058, h: 260, o: 0.3, c: "#9B85FF", desce: false },
    { x: 1104, h: 440, o: 0.5, c: "#9B85FF", desce: false },
    { x: 1150, h: 320, o: 0.34, c: "#9B85FF", desce: false },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: "#07070a",
          backgroundImage:
            "radial-gradient(circle at 50% 40%, rgba(110,120,255,0.22), transparent 48%), radial-gradient(circle at 12% 0%, rgba(10,132,255,0.22), transparent 40%), radial-gradient(circle at 88% 100%, rgba(124,92,255,0.26), transparent 42%)",
          color: "white",
          fontFamily: "Inter",
        }}
      >
        {feixes.map((f) => (
          <div
            key={f.x}
            style={{
              position: "absolute",
              left: f.x,
              top: f.desce ? 0 : 630 - f.h,
              width: 22,
              height: f.h,
              borderRadius: 11,
              opacity: f.o,
              background: f.desce ? `linear-gradient(180deg, transparent, ${f.c})` : `linear-gradient(0deg, transparent, ${f.c})`,
            }}
          />
        ))}

        <div
          style={{
            display: "flex",
            width: 132,
            height: 132,
            borderRadius: 32,
            background: "linear-gradient(180deg, #1c1c22, #111114)",
            border: "1.5px solid rgba(255,255,255,0.1)",
            boxShadow: "0 24px 80px rgba(80,90,255,0.35)",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
          }}
        >
          <div style={{ width: 26, height: 64, borderRadius: 13, background: "linear-gradient(180deg, #b6a6ff, #7c5cff)", marginTop: -26 }} />
          <div style={{ width: 26, height: 64, borderRadius: 13, background: "linear-gradient(180deg, #7fc0ff, #2f8cff)", marginTop: 26 }} />
        </div>

        <div style={{ display: "flex", marginTop: 30, fontSize: 30, fontWeight: 600, letterSpacing: 6, color: "rgba(255,255,255,0.78)" }}>SOBEDESCE</div>

        <div
          style={{
            display: "flex",
            marginTop: 22,
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: -2.4,
            lineHeight: 1.06,
            textAlign: "center",
            maxWidth: 940,
            justifyContent: "center",
          }}
        >
          Arquivos gigantes no seu Google Drive.
        </div>

        <div style={{ display: "flex", marginTop: 34, gap: 12 }}>
          {["Sobe e desce rápido", "Retoma de onde parou", "Celular e computador"].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                padding: "11px 20px",
                borderRadius: 999,
                fontSize: 23,
                fontWeight: 500,
                color: "rgba(255,255,255,0.86)",
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: w500, weight: 500, style: "normal" },
        { name: "Inter", data: w600, weight: 600, style: "normal" },
        { name: "Inter", data: w700, weight: 700, style: "normal" },
      ],
    },
  );
}
