/**
 * App na Tela de Início (iPhone e Android): o mesmo app do /app/, instalável de qualquer página do site.
 * As telas de abertura ficam em public/app/icons/splash (uma por tamanho de iPhone, clara e escura); sem elas o
 * iPhone mostra um branco antes do app aparecer.
 */

/** Largura × altura em pontos e a densidade de cada tamanho de tela de iPhone em uso (do SE ao 17 Pro Max). */
export const TELAS_IPHONE: ReadonlyArray<readonly [number, number, number]> = [
  [440, 956, 3],
  [420, 912, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 896, 3],
  [414, 896, 2],
  [375, 667, 2],
];

export function telasDeAbertura(): { url: string; media: string }[] {
  return TELAS_IPHONE.flatMap(([w, h, d]) =>
    (["light", "dark"] as const).map((tema) => ({
      url: `/app/icons/splash/splash-${w * d}x${h * d}-${tema}.png`,
      media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${d}) and (orientation: portrait) and (prefers-color-scheme: ${tema})`,
    })),
  );
}
