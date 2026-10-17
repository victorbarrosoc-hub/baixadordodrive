// Textos do "Copiar link" (mandar para o cliente): o aviso depois de copiar e a confirmação de liberar. Sem
// dependência do navegador, para testar no Node. O link e a permissão vêm de GET /api/drive/:acc/link.

export const CONFIRMAR_LIBERAR = 'Qualquer pessoa com o link vai poder ver e baixar.'
export const LIBERAR = 'Liberar para quem tiver o link'

/**
 * Aviso depois de copiar. `link`: { access, domain, isFolder, canShare, podeLiberar } (ou null: não deu para conferir).
 * Devolve { tone: 'ok'|'aviso', texto, nota?, liberar: boolean }. `liberar` só oferece o botão (que ainda pede
 * confirmação): nada aqui libera sozinho.
 */
export function avisoDoLink(link, { copiado = true } = {}) {
  const alvo = link?.isFolder === false ? 'a este arquivo' : 'a esta pasta'
  const inicio = copiado ? 'Copiado.' : 'Link pronto.'
  if (!link) return { tone: 'aviso', texto: `${inicio} Não consegui conferir quem consegue abrir.`, liberar: false }
  const liberar = link.podeLiberar === true
  const semPoder =
    link.access === 'qualquer'
      ? null
      : link.root
        ? link.sharedDrive
          ? 'A raiz de um drive compartilhado não pode ser liberada: libere uma pasta dentro dele.'
          : 'O Meu Drive inteiro não pode ser liberado: libere uma pasta dentro dele.'
        : link.canShare === false
          ? 'Sua conta não pode mudar o compartilhamento: peça a quem é dono.'
          : null
  switch (link.access) {
    case 'qualquer':
      return { tone: 'ok', texto: `${inicio} Qualquer pessoa com o link consegue abrir.`, liberar: false }
    case 'dominio':
      return { tone: 'aviso', texto: `${inicio} Só quem é de ${link.domain || 'sua organização'} consegue abrir.`, nota: semPoder, liberar }
    case 'restrito':
      return { tone: 'aviso', texto: `${inicio} Só quem tem acesso ${alvo} consegue abrir.`, nota: semPoder, liberar }
    default:
      return { tone: 'aviso', texto: `${inicio} Não consegui conferir quem consegue abrir.`, nota: semPoder, liberar }
  }
}
