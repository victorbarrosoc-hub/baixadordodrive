// Modos prontos da calculadora de mídia, cada um com a fonte do fabricante (docs/CARTOES.md §6: nada inventado).
// Os valores são o máximo do modo segundo o fabricante (as câmeras costumam gravar abaixo disso). Modo sem fonte
// oficial não entra: a pessoa digita o bitrate. Cópia idêntica em public/lib/midia-modos.js (test/midia-conta.test.js).

const SONY_FX3 = { fonte: 'https://helpguide.sony.net/ilc/2210/v1/en/contents/TP1000868278.html', fonteNome: 'Help Guide Sony ILME-FX3' }
const SONY_A7S3 = { fonte: 'https://helpguide.sony.net/ilc/2410/v1/en/contents/0412B_movie_setting.html', fonteNome: 'Help Guide Sony ILCE-7SM3' }
const SONY_A7IV = { fonte: 'https://helpguide.sony.net/ilc/2110/v1/en/contents/TP1000640834.html', fonteNome: 'Help Guide Sony ILCE-7M4' }
const SONY_FX30 = { fonte: 'https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1000868278.html', fonteNome: 'Help Guide Sony ILME-FX30' }
const SONY_FX6 = { fonte: 'https://www.sony.co.in/interchangeable-lens-cameras/products/ilme-fx6/spec', fonteNome: 'Especificações Sony ILME-FX6' }
const CANON_R6M2 = { fonte: 'https://cam.start.canon/en/C012/manual/html/UG-10_Reference_0100.html', fonteNome: 'Manual Canon EOS R6 Mark II' }
const CANON_C70 = { fonte: 'https://hk.canon/en/business/eos-c70/main/specification', fonteNome: 'Especificações Canon EOS C70' }
const BMD_6K = { fonte: 'https://www.blackmagicdesign.com/products/blackmagicpocketcinemacamera/techspecs/W-CIN-24', fonteNome: 'Especificações Blackmagic Pocket 6K Pro' }
const APPLE_PRORES = { fonte: 'https://www.apple.com/final-cut-pro/docs/Apple_ProRes.pdf', fonteNome: 'White paper Apple ProRes' }

export const MODOS = [
  { id: 'fx3-si-24', camera: 'Sony FX3', modo: 'XAVC S-I 4K 23.98p', mbps: 240, ...SONY_FX3 },
  { id: 'fx3-si-30', camera: 'Sony FX3', modo: 'XAVC S-I 4K 29.97p', mbps: 300, ...SONY_FX3 },
  { id: 'fx3-si-60', camera: 'Sony FX3', modo: 'XAVC S-I 4K 59.94p', mbps: 600, ...SONY_FX3 },
  { id: 'fx3-hs-24', camera: 'Sony FX3', modo: 'XAVC HS 4K 23.98p', mbps: 100, ...SONY_FX3 },
  { id: 'fx3-s-24', camera: 'Sony FX3', modo: 'XAVC S 4K 23.98p 10 bits', mbps: 100, ...SONY_FX3 },
  { id: 'fx3-s-30', camera: 'Sony FX3', modo: 'XAVC S 4K 29.97p 10 bits', mbps: 140, ...SONY_FX3 },

  { id: 'fx30-si-24', camera: 'Sony FX30', modo: 'XAVC S-I 4K 23.98p', mbps: 240, ...SONY_FX30 },
  { id: 'fx30-si-30', camera: 'Sony FX30', modo: 'XAVC S-I 4K 29.97p', mbps: 300, ...SONY_FX30 },
  { id: 'fx30-si-60', camera: 'Sony FX30', modo: 'XAVC S-I 4K 59.94p', mbps: 600, ...SONY_FX30 },
  { id: 'fx30-hs-24', camera: 'Sony FX30', modo: 'XAVC HS 4K 23.98p', mbps: 100, ...SONY_FX30 },
  { id: 'fx30-s-30', camera: 'Sony FX30', modo: 'XAVC S 4K 29.97p 10 bits', mbps: 140, ...SONY_FX30 },

  { id: 'fx6-i-24', camera: 'Sony FX6', modo: 'XAVC-I 4K 23.98p', mbps: 240, ...SONY_FX6 },
  { id: 'fx6-i-30', camera: 'Sony FX6', modo: 'XAVC-I 4K 29.97p', mbps: 300, ...SONY_FX6 },
  { id: 'fx6-i-60', camera: 'Sony FX6', modo: 'XAVC-I 4K 59.94p', mbps: 600, ...SONY_FX6 },

  { id: 'a7s3-si-24', camera: 'Sony A7S III', modo: 'XAVC S-I 4K 24p', mbps: 240, ...SONY_A7S3 },
  { id: 'a7s3-si-30', camera: 'Sony A7S III', modo: 'XAVC S-I 4K 30p', mbps: 300, ...SONY_A7S3 },
  { id: 'a7s3-si-60', camera: 'Sony A7S III', modo: 'XAVC S-I 4K 60p', mbps: 600, ...SONY_A7S3 },
  { id: 'a7s3-hs-24', camera: 'Sony A7S III', modo: 'XAVC HS 4K 24p', mbps: 100, ...SONY_A7S3 },
  { id: 'a7s3-s-30', camera: 'Sony A7S III', modo: 'XAVC S 4K 30p 10 bits', mbps: 140, ...SONY_A7S3 },

  { id: 'a7iv-si-24', camera: 'Sony A7 IV', modo: 'XAVC S-I 4K 24p', mbps: 240, ...SONY_A7IV },
  { id: 'a7iv-si-30', camera: 'Sony A7 IV', modo: 'XAVC S-I 4K 30p', mbps: 300, ...SONY_A7IV },
  { id: 'a7iv-hs-24', camera: 'Sony A7 IV', modo: 'XAVC HS 4K 24p', mbps: 100, ...SONY_A7IV },
  { id: 'a7iv-s-24', camera: 'Sony A7 IV', modo: 'XAVC S 4K 24p 10 bits', mbps: 100, ...SONY_A7IV },
  { id: 'a7iv-s-30', camera: 'Sony A7 IV', modo: 'XAVC S 4K 30p 10 bits', mbps: 140, ...SONY_A7IV },

  { id: 'r6m2-ipb-30', camera: 'Canon EOS R6 Mark II', modo: '4K 23.98/29.97p IPB (Standard)', mbps: 120, ...CANON_R6M2 },
  { id: 'r6m2-ipbl-30', camera: 'Canon EOS R6 Mark II', modo: '4K 23.98/29.97p IPB (Light)', mbps: 60, ...CANON_R6M2 },
  { id: 'r6m2-log-30', camera: 'Canon EOS R6 Mark II', modo: '4K 23.98/29.97p IPB, Canon Log', mbps: 170, ...CANON_R6M2 },
  { id: 'r6m2-ipb-60', camera: 'Canon EOS R6 Mark II', modo: '4K 59.94p IPB (Standard)', mbps: 230, ...CANON_R6M2 },
  { id: 'r6m2-log-60', camera: 'Canon EOS R6 Mark II', modo: '4K 59.94p IPB, Canon Log', mbps: 340, ...CANON_R6M2 },

  { id: 'c70-intra-25', camera: 'Canon EOS C70', modo: 'XF-AVC Intra 4K 25p', mbps: 410, ...CANON_C70 },
  { id: 'c70-lgop-50', camera: 'Canon EOS C70', modo: 'XF-AVC Long GOP 4K 50p', mbps: 260, ...CANON_C70 },

  { id: 'bmpcc6k-3', camera: 'Blackmagic Pocket 6K Pro / G2', modo: 'BRAW 3:1 6K 30p', mbps: 2584, nota: 'publicado como 323 MB/s', ...BMD_6K },
  { id: 'bmpcc6k-5', camera: 'Blackmagic Pocket 6K Pro / G2', modo: 'BRAW 5:1 6K 30p', mbps: 1552, nota: 'publicado como 194 MB/s', ...BMD_6K },
  { id: 'bmpcc6k-8', camera: 'Blackmagic Pocket 6K Pro / G2', modo: 'BRAW 8:1 6K 30p', mbps: 968, nota: 'publicado como 121 MB/s', ...BMD_6K },
  { id: 'bmpcc6k-12', camera: 'Blackmagic Pocket 6K Pro / G2', modo: 'BRAW 12:1 6K 30p', mbps: 648, nota: 'publicado como 81 MB/s', ...BMD_6K },

  { id: 'mavic3pro', camera: 'DJI Mavic 3 Pro', modo: 'H.264/H.265, máximo', mbps: 200, fonte: 'https://www.dji.com/mavic-3-pro/specs', fonteNome: 'Especificações DJI Mavic 3 Pro' },
  { id: 'air3', camera: 'DJI Air 3', modo: 'H.264/H.265, máximo', mbps: 150, fonte: 'https://www.dji.com/air-3/specs', fonteNome: 'Especificações DJI Air 3' },
  { id: 'mini4pro', camera: 'DJI Mini 4 Pro', modo: 'H.264/H.265, máximo', mbps: 150, fonte: 'https://www.dji.com/mini-4-pro/specs', fonteNome: 'Especificações DJI Mini 4 Pro' },
  { id: 'pocket3', camera: 'DJI Osmo Pocket 3', modo: 'H.264/H.265, máximo', mbps: 130, fonte: 'https://www.dji.com/osmo-pocket-3/specs', fonteNome: 'Especificações DJI Osmo Pocket 3' },
  { id: 'action4', camera: 'DJI Osmo Action 4', modo: 'H.264/H.265, máximo', mbps: 130, fonte: 'https://www.dji.com/osmo-action-4/specs', fonteNome: 'Especificações DJI Osmo Action 4' },

  { id: 'hero12', camera: 'GoPro HERO12 Black', modo: 'H.265, máximo', mbps: 120, fonte: 'https://gopro.com/en/bs/shop/cameras/hero12-black/CHDHX-121-master.html', fonteNome: 'Especificações GoPro HERO12 Black' },
  { id: 'hero13', camera: 'GoPro HERO13 Black', modo: 'H.265, máximo', mbps: 120, fonte: 'https://gopro.com/en/us/compare', fonteNome: 'Comparativo GoPro' },

  { id: 'prores-hq-24', camera: 'ProRes (iPhone e outras)', modo: 'ProRes 422 HQ 4K 24p', mbps: 707, nota: 'taxa-alvo do formato', ...APPLE_PRORES },
  { id: 'prores-hq-30', camera: 'ProRes (iPhone e outras)', modo: 'ProRes 422 HQ 4K 30p', mbps: 884, nota: 'taxa-alvo do formato', ...APPLE_PRORES },
  { id: 'prores-422-30', camera: 'ProRes (iPhone e outras)', modo: 'ProRes 422 4K 30p', mbps: 589, nota: 'taxa-alvo do formato', ...APPLE_PRORES },
  { id: 'prores-lt-30', camera: 'ProRes (iPhone e outras)', modo: 'ProRes 422 LT 4K 30p', mbps: 410, nota: 'taxa-alvo do formato', ...APPLE_PRORES },
]
