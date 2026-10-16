/**
 * Simulações usadas nas animações da home. Seguem o que o motor faz de verdade
 * (docs/ARCHITECTURE.md): no download, N conexões dividem o arquivo em pedaços; quando
 * uma termina, ela pega metade do maior pedaço que falta. No upload, cada arquivo vai num
 * fluxo contínuo e o paralelismo vem de vários arquivos ao mesmo tempo.
 * Os números são só de ilustração: nenhum deles vira velocidade na tela.
 */

/** Gerador pseudoaleatório com semente (o quadro estático sai sempre igual). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Segment = { start: number; end: number; pos: number; owner: number | null };
export type Connection = { id: number; seg: Segment | null; factor: number; phase: number };
export type StealEvent = { thief: number; victim: number };

export class SegmentedDownload {
  segments: Segment[] = [];
  conns: Connection[] = [];
  elapsed = 0;
  private rand: () => number;

  constructor(
    readonly connections = 8,
    /** Segundos, mais ou menos, para o arquivo inteiro. */
    readonly duration = 7,
    seed = 7,
    private onSteal?: (e: StealEvent) => void,
  ) {
    this.rand = mulberry32(seed);
    this.reset();
  }

  reset() {
    const n = this.connections;
    this.elapsed = 0;
    this.segments = Array.from({ length: n }, (_, i) => ({ start: i / n, end: (i + 1) / n, pos: i / n, owner: i }));
    this.conns = this.segments.map((seg, i) => ({
      id: i,
      seg,
      factor: 0.62 + this.rand() * 0.76,
      phase: this.rand() * Math.PI * 2,
    }));
  }

  get progress() {
    let done = 0;
    for (const s of this.segments) done += s.pos - s.start;
    return Math.min(1, done);
  }

  get done() {
    return this.segments.every((s) => s.pos >= s.end - 1e-9);
  }

  get active() {
    return this.conns.filter((c) => c.seg).length;
  }

  step(dt: number) {
    this.elapsed += dt;
    const base = 1 / (this.connections * this.duration);
    for (const c of this.conns) {
      const seg = c.seg;
      if (!seg) continue;
      // Cada conexão tem o seu ritmo, e o ritmo oscila um pouco (a rede nunca é lisa).
      const wobble = 0.82 + 0.18 * Math.sin(this.elapsed * 1.7 + c.phase);
      seg.pos = Math.min(seg.end, seg.pos + base * c.factor * wobble * dt);
      if (seg.pos >= seg.end) {
        seg.owner = null;
        c.seg = null;
        this.steal(c);
      }
    }
  }

  /** A conexão que terminou pega metade do maior pedaço que falta. */
  private steal(c: Connection) {
    let biggest: Segment | null = null;
    for (const s of this.segments) {
      if (s.owner === null) continue;
      if (!biggest || s.end - s.pos > biggest.end - biggest.pos) biggest = s;
    }
    if (!biggest || biggest.end - biggest.pos < 0.018) return;
    const mid = biggest.pos + (biggest.end - biggest.pos) / 2;
    const fresh: Segment = { start: mid, end: biggest.end, pos: mid, owner: c.id };
    const victim = biggest.owner as number;
    biggest.end = mid;
    this.segments.push(fresh);
    this.segments.sort((a, b) => a.start - b.start);
    c.seg = fresh;
    this.onSteal?.({ thief: c.id, victim });
  }
}

export type UploadSlot = { p: number; rate: number; hold: number; flash: number; file: number };

/** Vários arquivos subindo juntos, cada um num fluxo contínuo. */
export class ParallelUpload {
  slots: UploadSlot[];
  private rand: () => number;
  private next = 0;

  constructor(
    readonly count = 4,
    seed = 11,
  ) {
    this.rand = mulberry32(seed);
    this.slots = Array.from({ length: count }, (_, i) => ({
      p: this.rand() * 0.7,
      rate: this.newRate(),
      hold: 0,
      flash: 0,
      file: i,
    }));
    this.next = count;
  }

  private newRate() {
    return 1 / (4.2 + this.rand() * 3.4);
  }

  step(dt: number) {
    for (const s of this.slots) {
      s.flash = Math.max(0, s.flash - dt * 1.6);
      if (s.hold > 0) {
        s.hold -= dt;
        if (s.hold <= 0) {
          s.p = 0;
          s.rate = this.newRate();
          s.file = this.next++;
        }
        continue;
      }
      s.p = Math.min(1, s.p + s.rate * dt);
      if (s.p >= 1) {
        s.hold = 0.9;
        s.flash = 1;
      }
    }
  }
}
