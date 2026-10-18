#!/bin/sh
# SOBEDESCE · instalador para Mac, sem o aviso "A Apple não pôde verificar se o item SOBEDESCE está livre de malware".
#
#   curl -fsSL https://sobedesce.com/instalar.sh | bash
#
# Por que funciona: o aviso vem da "quarentena" que o navegador põe em tudo o que baixa. O curl não põe.
# O que este script faz, nesta ordem:
#   1. lê a versão mais nova e o SHA-256 do instalador em /baixar/versao;
#   2. baixa o .dmg de /baixar/mac e confere o SHA-256 (não bateu = não instala nada);
#   3. fecha o SOBEDESCE, se estiver aberto (as transferências pausam e continuam depois);
#   4. abre o .dmg, copia o app para Aplicativos (troca o antigo; pede a senha do Mac só se precisar),
#      tira a quarentena (xattr -cr), fecha o .dmg e abre o app.
# Tudo fica dentro da função main, chamada só na última linha: um download cortado no meio não roda pela metade.

main() {
  set -eu

  SITE="${SOBEDESCE_SITE:-https://sobedesce.com}"
  DEST="/Applications/SOBEDESCE.app"
  NOVO="/Applications/.SOBEDESCE-instalando.app"
  ANTIGO="/Applications/.SOBEDESCE-antigo.app"
  TMP=""
  MNT=""
  MONTADO=0
  SUDO=""

  if [ -t 1 ]; then
    NEGRITO="$(printf '\033[1m')"
    FRACO="$(printf '\033[2m')"
    VERDE="$(printf '\033[32m')"
    VERMELHO="$(printf '\033[31m')"
    FIM="$(printf '\033[0m')"
  else
    NEGRITO="" FRACO="" VERDE="" VERMELHO="" FIM=""
  fi

  passo() { printf '\n%s%s%s %s\n' "$NEGRITO" "$1" "$FIM" "$2"; }
  nota() { printf '  %s%s%s\n' "$FRACO" "$1" "$FIM"; }
  erro() {
    printf '\n%s✕ %s%s\n' "$VERMELHO" "$1" "$FIM" >&2
    [ "$#" -gt 1 ] && printf '  %s\n' "$2" >&2
    exit 1
  }

  limpar() {
    if [ "$MONTADO" = 1 ]; then
      hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 || true
      MONTADO=0
    fi
    if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  }
  trap limpar EXIT
  trap 'exit 130' INT TERM HUP

  printf '%sSOBEDESCE%s · instalação pelo Terminal\n' "$NEGRITO" "$FIM"

  [ "$(uname -s)" = "Darwin" ] || erro "Este instalador é para Mac." "No Windows, abra o PowerShell e rode: irm $SITE/instalar.ps1 | iex"
  for cmd in curl hdiutil ditto shasum xattr open; do
    command -v "$cmd" >/dev/null 2>&1 || erro "Falta o comando \"$cmd\" neste Mac."
  done

  # 1. Versão mais nova e o SHA-256 do instalador
  passo "1/4" "Procurando a versão mais nova…"
  VERSAO="$(curl -fsSL --retry 2 --connect-timeout 15 "$SITE/baixar/versao" 2>/dev/null)" ||
    erro "Não consegui falar com o site." "Confira a internet e rode o comando de novo."
  BUILD="$(printf '%s' "$VERSAO" | grep -Eo '"build"[[:space:]]*:[[:space:]]*[0-9]+' | grep -Eo '[0-9]+$' || true)"
  SHA="$(printf '%s' "$VERSAO" | grep -Eo '"sha256Mac"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{64}"' | grep -Eo '[0-9a-fA-F]{64}' | tr 'A-F' 'a-f' || true)"
  [ -n "$BUILD" ] || erro "O site não respondeu com uma versão." "Tente de novo em alguns minutos."
  [ -n "$SHA" ] || erro "O site ainda não publicou a conferência (SHA-256) desta versão." "Tente de novo em alguns minutos."
  nota "build $BUILD"

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/sobedesce.XXXXXX")"
  DMG="$TMP/SOBEDESCE.dmg"
  MNT="$TMP/montagem"

  # 2. Baixa e confere
  passo "2/4" "Baixando o SOBEDESCE…"
  curl -fL --retry 2 --connect-timeout 15 --progress-bar -o "$DMG" "$SITE/baixar/mac?build=$BUILD" ||
    erro "O download não terminou." "Confira a internet e rode o comando de novo."
  GOT="$(shasum -a 256 "$DMG" | awk '{print $1}')"
  if [ "$GOT" != "$SHA" ]; then
    erro "O arquivo baixado não bate com a conferência do site (SHA-256). Nada foi instalado." \
      "Pode ser uma versão nova sendo publicada agora: espere uns minutos e rode de novo."
  fi
  nota "conferido (SHA-256 ${SHA%"${SHA#????????????}"}…)"

  # 3. Fecha o app aberto
  if pgrep -x SOBEDESCE >/dev/null 2>&1; then
    passo "3/4" "Fechando o SOBEDESCE aberto…"
    nota "Transferências em andamento pausam e continuam quando o app abrir de novo."
    osascript -e 'quit app "SOBEDESCE"' >/dev/null 2>&1 || true
    i=0
    while pgrep -x SOBEDESCE >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -gt 60 ] && erro "O SOBEDESCE não fechou." "Feche o app (⌘Q) e rode o comando de novo."
      sleep 1
    done
  else
    passo "3/4" "O SOBEDESCE não está aberto. Seguindo."
  fi

  # 4. Instala em Aplicativos
  passo "4/4" "Instalando em Aplicativos…"
  mkdir "$MNT"
  hdiutil attach "$DMG" -nobrowse -noautoopen -readonly -mountpoint "$MNT" -quiet ||
    erro "Não consegui abrir o instalador baixado." "Rode o comando de novo. Se continuar, baixe pelo site: $SITE/baixar/mac"
  MONTADO=1
  [ -d "$MNT/SOBEDESCE.app" ] || erro "O instalador baixado não tem o app dentro."

  if [ -w /Applications ] && { [ ! -e "$DEST" ] || [ -w "$DEST" ]; }; then
    SUDO=""
  else
    nota "Para gravar em Aplicativos, o macOS vai pedir a senha deste Mac (a mesma de entrar no computador)."
    SUDO="sudo"
  fi

  $SUDO rm -rf "$NOVO" "$ANTIGO"
  $SUDO ditto "$MNT/SOBEDESCE.app" "$NOVO" ||
    { $SUDO rm -rf "$NOVO"; erro "Não consegui copiar o app para Aplicativos."; }
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || hdiutil detach "$MNT" -force -quiet >/dev/null 2>&1 || true
  MONTADO=0

  # Troca: o antigo sai do caminho, o novo entra; se algo falhar, o antigo volta.
  if [ -e "$DEST" ]; then
    $SUDO mv "$DEST" "$ANTIGO" 2>/dev/null || {
      $SUDO rm -rf "$NOVO"
      erro "O macOS não deixou trocar o app em Aplicativos." \
        "Abra Ajustes do Sistema → Privacidade e Segurança → Gerenciamento de Apps, ligue o Terminal e rode de novo. Ou apague o SOBEDESCE de Aplicativos e rode de novo."
    }
  fi
  if ! $SUDO mv "$NOVO" "$DEST"; then
    if [ -e "$ANTIGO" ]; then $SUDO mv "$ANTIGO" "$DEST" || true; fi
    $SUDO rm -rf "$NOVO"
    erro "Não consegui pôr o app novo em Aplicativos. O app antigo continua lá."
  fi
  $SUDO rm -rf "$ANTIGO"
  # Instalado com sudo: o app fica com o seu usuário (como ao arrastar), para o Atualizar do app conseguir trocá-lo.
  if [ -n "$SUDO" ]; then $SUDO chown -R "$(id -un)" "$DEST" 2>/dev/null || true; fi
  # Sem quarentena: nada de "A Apple não pôde verificar…" ao abrir.
  $SUDO xattr -cr "$DEST" 2>/dev/null || true

  printf '\n%s✓ SOBEDESCE instalado em Aplicativos (build %s).%s\n' "$VERDE" "$BUILD" "$FIM"
  open "$DEST" 2>/dev/null || nota "Abra o SOBEDESCE em Aplicativos."
  nota "Para atualizar depois, use o botão Atualizar dentro do app ou rode este mesmo comando."
}

main "$@"
