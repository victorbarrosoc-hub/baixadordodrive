import { ImageResponse } from "next/og";

export const alt = "SOBEDESCE: o Drive na velocidade que a sua internet aguenta.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Imagem de compartilhamento: fundo escuro, feixes azuis descendo e violetas subindo. */
export default function OpengraphImage() {
  const down = [0, 1, 2, 3, 4, 5, 6, 7];
  const up = [0, 1, 2, 3];
  const fills = [0.92, 0.78, 1, 0.66, 0.85, 0.71, 0.97, 0.6];
  const ups = [0.82, 0.48, 0.66, 0.3];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#060608",
          backgroundImage:
            "radial-gradient(circle at 18% 100%, rgba(10,132,255,0.35), transparent 45%), radial-gradient(circle at 82% 100%, rgba(124,92,255,0.38), transparent 45%)",
          padding: "64px 72px",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", width: 48, height: 48, borderRadius: 14, background: "#16161a", alignItems: "center", justifyContent: "center", gap: 7 }}>
            <div style={{ width: 8, height: 18, borderRadius: 4, background: "#9B85FF", marginTop: -6 }} />
            <div style={{ width: 8, height: 18, borderRadius: 4, background: "#3D9CFF", marginTop: 8 }} />
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 2 }}>SOBEDESCE</div>
        </div>

        <div style={{ display: "flex", marginTop: 44, fontSize: 68, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2, maxWidth: 900 }}>
          O Drive na velocidade que a sua internet aguenta.
        </div>

        <div style={{ display: "flex", marginTop: "auto", alignItems: "flex-end", gap: 64 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
            <div style={{ display: "flex", height: 16, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.08)", gap: 3 }}>
              {down.map((i) => (
                <div key={i} style={{ display: "flex", flex: 1, height: "100%", background: "rgba(255,255,255,0.04)" }}>
                  <div style={{ width: `${fills[i] * 100}%`, height: "100%", background: "linear-gradient(90deg, #0a6fe0, #4aa3ff)" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", fontSize: 24, color: "rgba(255,255,255,0.7)" }}>Desce · 8 conexões no mesmo arquivo</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
              {up.map((j) => (
                <div
                  key={j}
                  style={{ display: "flex", alignItems: "flex-end", width: 34, height: 110, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.08)" }}
                >
                  <div style={{ width: "100%", height: `${ups[j] * 100}%`, background: "linear-gradient(0deg, #5b3df0, #a995ff)" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", fontSize: 24, color: "rgba(255,255,255,0.7)" }}>Sobe · 4 arquivos juntos</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
