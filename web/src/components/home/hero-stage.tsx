"use client";

import { useEffect, useRef } from "react";
import { ParallelUpload, SegmentedDownload } from "./transfer-sim";

/**
 * O palco do topo da home, desenhado em canvas.
 * Esquerda (desce): um arquivo só, oito conexões, cada uma num pedaço; quando uma termina,
 * pega metade do maior pedaço que falta. Direita (sobe): quatro arquivos, um fluxo cada.
 * Com "reduzir movimento" o quadro fica parado num momento bonito da animação.
 */

const BLUE = "10,132,255";
const BLUE_SOFT = "108,182,255";
const VIOLET = "124,92,255";
const VIOLET_SOFT = "169,149,255";
const OK = "48,209,88";
const BG = "#060608";
const MONO = 'ui-monospace, "SF Mono", Menlo, "Roboto Mono", monospace';
const DOWN_FILE = "A001_C003_0915.mov";
const UP_FILES = ["B002_C014.mov", "B002_C015.mov", "SOM_DIA02.wav", "B002_C016.mov", "PROXY_C017.mp4", "B002_C018.mov"];

type Pt = { x: number; y: number };
type Bez = [Pt, Pt, Pt, Pt];

function bez(b: Bez, u: number): Pt {
  const v = 1 - u;
  const a = v * v * v;
  const c1 = 3 * v * v * u;
  const c2 = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
    y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const PARTICLES = 5;

export function HeroStage() {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = reduceQuery.matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let t = 0;
    let raf = 0;
    let last = 0;
    let visible = true;
    let onScreen = true;

    const down = new SegmentedDownload(8, 8, 7);
    const up = new ParallelUpload(4, 11);
    let doneHold = 0;
    const beamX = new Float64Array(8).fill(NaN);
    const beamAlpha = new Float64Array(8).fill(1);
    const downPhase = Array.from({ length: 8 }, (_, i) => Array.from({ length: PARTICLES }, (_, k) => (k / PARTICLES + i * 0.137) % 1));
    const upPhase = Array.from({ length: 4 }, (_, j) => Array.from({ length: PARTICLES }, (_, k) => (k / PARTICLES + j * 0.29) % 1));

    function geometry() {
      const narrow = w < 640;
      const pad = narrow ? 18 : Math.max(40, w * 0.05);
      const gap = narrow ? 14 : 40;
      const mid = w / 2;
      const L = { x0: pad, x1: mid - gap };
      const R = { x0: mid + gap, x1: w - pad };
      const topY = h * 0.17;
      const barY = h * 0.68;
      const barH = narrow ? 10 : 14;
      const capW = narrow ? 22 : Math.min(46, (R.x1 - R.x0) * 0.12);
      const capH = h * (narrow ? 0.2 : 0.24);
      const capBottom = barY + barH / 2;
      const lw = L.x1 - L.x0;
      const rw = R.x1 - R.x0;
      return {
        narrow,
        L,
        R,
        topY,
        barY,
        barH,
        capW,
        capH,
        capBottom,
        downAnchor: (i: number) => L.x0 + lw * (0.07 + (0.86 * i) / 7),
        capX: (j: number) => R.x0 + rw * (0.13 + (0.74 * j) / 3),
        upAnchor: (j: number) => R.x0 + rw * (0.08 + (0.84 * j) / 3),
      };
    }

    function resize() {
      const r = box!.getBoundingClientRect();
      w = r.width;
      h = r.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = Math.max(1, Math.round(w * dpr));
      canvas!.height = Math.max(1, Math.round(h * dpr));
      beamX.fill(NaN);
      draw(0);
    }

    function update(dt: number) {
      t += dt;
      if (down.done) {
        doneHold += dt;
        if (doneHold > 1.8) {
          down.reset();
          doneHold = 0;
          beamX.fill(NaN);
        }
      } else {
        down.step(dt);
      }
      up.step(dt);
      for (let i = 0; i < 8; i++) {
        const c = down.conns[i];
        const target = c.seg ? 1 : 0;
        beamAlpha[i] += (target - beamAlpha[i]) * (1 - Math.exp(-dt * (target ? 6 : 3)));
        const speed = 0.42 + 0.22 * c.factor;
        for (let k = 0; k < PARTICLES; k++) downPhase[i][k] = (downPhase[i][k] + dt * speed) % 1;
      }
      for (let j = 0; j < 4; j++) {
        const s = up.slots[j];
        const speed = s.hold > 0 ? 0.25 : 0.5;
        for (let k = 0; k < PARTICLES; k++) upPhase[j][k] = (upPhase[j][k] + dt * speed) % 1;
      }
    }

    function stroke(b: Bez, from: number, to: number) {
      const steps = 6;
      ctx!.beginPath();
      for (let s = 0; s <= steps; s++) {
        const p = bez(b, from + ((to - from) * s) / steps);
        if (s === 0) ctx!.moveTo(p.x, p.y);
        else ctx!.lineTo(p.x, p.y);
      }
      ctx!.stroke();
    }

    function draw(dt: number) {
      if (!w || !h) return;
      const g = geometry();
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      ctx!.lineCap = "round";

      // Linha do Google Drive no alto.
      const line = ctx!.createLinearGradient(g.L.x0, 0, g.R.x1, 0);
      line.addColorStop(0, `rgba(${BLUE},0)`);
      line.addColorStop(0.22, `rgba(${BLUE_SOFT},0.5)`);
      line.addColorStop(0.5, "rgba(255,255,255,0.32)");
      line.addColorStop(0.78, `rgba(${VIOLET_SOFT},0.5)`);
      line.addColorStop(1, `rgba(${VIOLET},0)`);
      ctx!.strokeStyle = line;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(g.L.x0 - 10, g.topY);
      ctx!.lineTo(g.R.x1 + 10, g.topY);
      ctx!.stroke();

      const barX0 = g.L.x0;
      const barW = g.L.x1 - g.L.x0;
      const barTop = g.barY - g.barH / 2;
      const k = 1 - Math.exp(-dt * 9);

      // ── Desce: feixes das conexões até a cabeça de cada pedaço.
      const downBeams: Bez[] = [];
      for (let i = 0; i < 8; i++) {
        const c = down.conns[i];
        const tx = c.seg ? barX0 + c.seg.pos * barW : beamX[i];
        if (Number.isNaN(beamX[i]) || dt === 0) beamX[i] = Number.isNaN(tx) ? barX0 + ((i + 0.5) / 8) * barW : tx;
        else if (!Number.isNaN(tx)) beamX[i] += (tx - beamX[i]) * k;
        const ax = g.downAnchor(i);
        const span = barTop - g.topY;
        downBeams.push([
          { x: ax, y: g.topY },
          { x: ax, y: g.topY + span * 0.5 },
          { x: beamX[i], y: barTop - span * 0.42 },
          { x: beamX[i], y: barTop - 3 },
        ]);
      }
      for (let i = 0; i < 8; i++) {
        const a = beamAlpha[i];
        if (a < 0.02) continue;
        const grad = ctx!.createLinearGradient(0, g.topY, 0, barTop);
        grad.addColorStop(0, `rgba(${BLUE},${0.05 * a})`);
        grad.addColorStop(1, `rgba(${BLUE_SOFT},${0.34 * a})`);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1;
        stroke(downBeams[i], 0, 1);
      }

      // ── Sobe: um fluxo por arquivo, do arquivo até o Drive.
      const upBeams: Bez[] = [];
      for (let j = 0; j < 4; j++) {
        const cx = g.capX(j);
        const capTop = g.capBottom - g.capH;
        const ax = g.upAnchor(j);
        const span = capTop - g.topY;
        upBeams.push([
          { x: cx, y: capTop - 3 },
          { x: cx, y: capTop - span * 0.45 },
          { x: ax, y: g.topY + span * 0.45 },
          { x: ax, y: g.topY },
        ]);
        const grad = ctx!.createLinearGradient(0, capTop, 0, g.topY);
        grad.addColorStop(0, `rgba(${VIOLET_SOFT},0.32)`);
        grad.addColorStop(1, `rgba(${VIOLET},0.05)`);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1;
        stroke(upBeams[j], 0, 1);
      }

      // Partículas (somam luz umas às outras).
      ctx!.globalCompositeOperation = "lighter";
      const trail = g.narrow ? 0.07 : 0.06;
      for (let i = 0; i < 8; i++) {
        const a = beamAlpha[i];
        if (a < 0.02) continue;
        for (let p = 0; p < PARTICLES; p++) {
          const u = downPhase[i][p];
          const fade = Math.sin(Math.PI * u) ** 0.7 * a;
          ctx!.strokeStyle = `rgba(${BLUE_SOFT},${0.95 * fade})`;
          ctx!.lineWidth = g.narrow ? 1.6 : 2;
          stroke(downBeams[i], Math.max(0, u - trail), u);
          const head = bez(downBeams[i], u);
          ctx!.fillStyle = `rgba(${BLUE},${0.22 * fade})`;
          ctx!.beginPath();
          ctx!.arc(head.x, head.y, g.narrow ? 4 : 5, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      for (let j = 0; j < 4; j++) {
        const hold = up.slots[j].hold > 0 ? 0.35 : 1;
        for (let p = 0; p < PARTICLES; p++) {
          const u = upPhase[j][p];
          const fade = Math.sin(Math.PI * u) ** 0.7 * hold;
          ctx!.strokeStyle = `rgba(${VIOLET_SOFT},${0.95 * fade})`;
          ctx!.lineWidth = g.narrow ? 1.6 : 2;
          stroke(upBeams[j], Math.max(0, u - trail), u);
          const head = bez(upBeams[j], u);
          ctx!.fillStyle = `rgba(${VIOLET},${0.26 * fade})`;
          ctx!.beginPath();
          ctx!.arc(head.x, head.y, g.narrow ? 4 : 5, 0, Math.PI * 2);
          ctx!.fill();
        }
      }

      // Pontos onde os feixes encostam no Drive.
      const pulse = 0.65 + 0.35 * Math.sin(t * 2.2);
      for (let i = 0; i < 8; i++) {
        const a = Math.max(0.25, beamAlpha[i]);
        ctx!.fillStyle = `rgba(${BLUE_SOFT},${0.18 * a * pulse})`;
        ctx!.beginPath();
        ctx!.arc(g.downAnchor(i), g.topY, 6, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${BLUE_SOFT},${0.9 * a})`;
        ctx!.beginPath();
        ctx!.arc(g.downAnchor(i), g.topY, 1.8, 0, Math.PI * 2);
        ctx!.fill();
      }
      for (let j = 0; j < 4; j++) {
        ctx!.fillStyle = `rgba(${VIOLET_SOFT},${0.2 * pulse})`;
        ctx!.beginPath();
        ctx!.arc(g.upAnchor(j), g.topY, 6, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${VIOLET_SOFT},0.9)`;
        ctx!.beginPath();
        ctx!.arc(g.upAnchor(j), g.topY, 1.8, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";

      // ── O arquivo que desce, em pedaços.
      roundRect(ctx!, barX0, barTop, barW, g.barH, g.barH / 2);
      ctx!.fillStyle = "rgba(255,255,255,0.07)";
      ctx!.fill();
      ctx!.save();
      roundRect(ctx!, barX0, barTop, barW, g.barH, g.barH / 2);
      ctx!.clip();
      const fill = ctx!.createLinearGradient(barX0, 0, barX0 + barW, 0);
      fill.addColorStop(0, "#0a6fe0");
      fill.addColorStop(1, "#4aa3ff");
      for (const s of down.segments) {
        const x = barX0 + s.start * barW;
        const fw = (s.pos - s.start) * barW;
        if (fw > 0) {
          ctx!.fillStyle = fill;
          ctx!.fillRect(x, barTop, fw, g.barH);
        }
        if (s.owner !== null) {
          ctx!.fillStyle = "rgba(255,255,255,0.95)";
          ctx!.fillRect(barX0 + s.pos * barW - 1, barTop, 2, g.barH);
        }
      }
      // Divisões entre os pedaços.
      ctx!.fillStyle = BG;
      for (const s of down.segments) {
        if (s.start <= 0) continue;
        ctx!.fillRect(barX0 + s.start * barW - 0.75, barTop, 1.5, g.barH);
      }
      if (down.done) {
        const a = Math.min(1, doneHold * 3) * (doneHold > 1.4 ? Math.max(0, 1 - (doneHold - 1.4) * 2.5) : 1);
        ctx!.fillStyle = `rgba(${OK},${0.85 * a})`;
        ctx!.fillRect(barX0, barTop, barW, g.barH);
      }
      ctx!.restore();

      const fs = g.narrow ? 10 : 12;
      const textY = barTop + g.barH + (g.narrow ? 18 : 24);
      ctx!.font = `500 ${fs}px ${MONO}`;
      ctx!.textBaseline = "alphabetic";
      ctx!.textAlign = "left";
      ctx!.fillStyle = "rgba(255,255,255,0.5)";
      ctx!.fillText(g.narrow ? "A001_C003.mov" : DOWN_FILE, barX0, textY);
      ctx!.textAlign = "right";
      if (down.done) {
        ctx!.fillStyle = `rgba(${OK},1)`;
        ctx!.fillText(g.narrow ? "conferido" : "conferido · MD5", barX0 + barW, textY);
      } else {
        ctx!.fillStyle = "rgba(255,255,255,0.92)";
        ctx!.fillText(`${Math.floor(down.progress * 100)}%`, barX0 + barW, textY);
      }

      // ── Os arquivos que sobem.
      for (let j = 0; j < 4; j++) {
        const s = up.slots[j];
        const cx = g.capX(j);
        const x = cx - g.capW / 2;
        const y = g.capBottom - g.capH;
        const r = Math.min(g.capW / 2, 12);
        roundRect(ctx!, x, y, g.capW, g.capH, r);
        ctx!.fillStyle = "rgba(255,255,255,0.07)";
        ctx!.fill();
        ctx!.save();
        roundRect(ctx!, x, y, g.capW, g.capH, r);
        ctx!.clip();
        const fh = g.capH * s.p;
        const vf = ctx!.createLinearGradient(0, g.capBottom, 0, y);
        vf.addColorStop(0, "#5b3df0");
        vf.addColorStop(1, "#a995ff");
        ctx!.fillStyle = vf;
        ctx!.fillRect(x, g.capBottom - fh, g.capW, fh);
        if (s.hold <= 0 && s.p > 0) {
          ctx!.fillStyle = "rgba(255,255,255,0.95)";
          ctx!.fillRect(x, g.capBottom - fh - 1, g.capW, 2);
        }
        if (s.flash > 0) {
          ctx!.fillStyle = `rgba(${OK},${0.85 * Math.min(1, s.flash * 1.4)})`;
          ctx!.fillRect(x, y, g.capW, g.capH);
        }
        ctx!.restore();
        ctx!.textAlign = "center";
        ctx!.font = `500 ${g.narrow ? 9 : 11}px ${MONO}`;
        if (s.hold > 0) {
          ctx!.fillStyle = `rgba(${OK},1)`;
          ctx!.fillText("ok", cx, textY);
        } else {
          ctx!.fillStyle = "rgba(255,255,255,0.75)";
          ctx!.fillText(`${Math.floor(s.p * 100)}%`, cx, textY);
        }
        if (!g.narrow) {
          ctx!.fillStyle = "rgba(255,255,255,0.32)";
          ctx!.font = `500 10px ${MONO}`;
          const name = UP_FILES[s.file % UP_FILES.length].replace(/\.[a-z0-9]+$/, "");
          ctx!.fillText(name, cx, textY + 16);
        }
      }
    }

    function frame(now: number) {
      raf = 0;
      if (!running()) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      update(dt);
      draw(dt);
      raf = requestAnimationFrame(frame);
    }

    function running() {
      return !reduce && visible && onScreen;
    }

    function sync() {
      if (running()) {
        if (!raf) {
          last = 0;
          raf = requestAnimationFrame(frame);
        }
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function staticFrame() {
      // Um momento com pedaços já "roubados" e arquivos em pontos diferentes.
      down.reset();
      for (let i = 0; i < 300; i++) update(1 / 60);
      for (let i = 0; i < 40 && !down.done; i++) update(0.1);
      // Arquivos que sobem em pontos diferentes, sem o verde de "concluído".
      [0.82, 0.38, 0.64, 0.21].forEach((p, j) => Object.assign(up.slots[j], { p, hold: 0, flash: 0 }));
      draw(0);
    }

    // Começa já com movimento acontecendo (sem o quadro vazio do início).
    for (let i = 0; i < 90; i++) update(1 / 60);
    if (reduce) staticFrame();

    const ro = new ResizeObserver(() => resize());
    ro.observe(box);
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        sync();
      },
      { rootMargin: "80px" },
    );
    io.observe(box);
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      sync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onReduce = () => {
      reduce = reduceQuery.matches;
      if (reduce) staticFrame();
      sync();
    };
    reduceQuery.addEventListener("change", onReduce);
    resize();
    sync();

    return () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceQuery.removeEventListener("change", onReduce);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={boxRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="block size-full" aria-hidden="true" />
    </div>
  );
}
