// QR code em SVG (qrcode-generator) e o passo a passo do Atalho do iPhone.
import qrcode from 'qrcode-generator'

const cache = new Map() // texto -> svg (os endereços quase nunca mudam; a tela de Ajustes consulta várias vezes)

/** SVG quadrado e escalável (sem largura fixa: o CSS decide o tamanho). Correção 'M': aguenta reflexo na tela. */
export function qrSvg(text) {
  const key = String(text)
  let svg = cache.get(key)
  if (!svg) {
    const qr = qrcode(0, 'M')
    qr.addData(key, 'Byte')
    qr.make()
    svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })
    if (cache.size > 20) cache.clear()
    cache.set(key, svg)
  }
  return svg
}

/** Passos para criar o Atalho "Enviar pro Drive pelo Mac" (menu Compartilhar do iPhone). */
export function shortcutSteps(dropUrl, platform = process.platform) {
  const pc = platform === 'win32' ? 'PC' : platform === 'darwin' ? 'Mac' : 'computador'
  return [
    'No iPhone, abra o app Atalhos e toque em + para criar um atalho.',
    'Toque em ⓘ (ou no nome, no topo) e ligue “Mostrar na Folha de Compartilhamento”. Em “Tipos”, deixe Arquivos (e Mídia, se quiser mandar da Fototeca).',
    `Adicione a ação “Obter Conteúdo do URL”. No URL, cole o endereço de envio direto${dropUrl ? '' : ' (aparece aqui quando a recepção estiver ligada)'} e, logo depois do “name=”, toque em Variável → Entrada do Atalho → Nome.`,
    'Toque em “Mostrar Mais”: Método POST; Corpo da Requisição: Arquivo; Arquivo: Entrada do Atalho.',
    `Adicione a ação “Mostrar Notificação” com o Conteúdo do URL — ela avisa quando o arquivo chegou no ${pc}.`,
    `Dê um nome, por exemplo “Enviar pro Drive pelo ${pc}”. Pronto: em qualquer app, toque em Compartilhar e escolha o atalho.`,
  ]
}
