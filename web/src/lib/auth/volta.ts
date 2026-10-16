/**
 * Parâmetro `volta` (para onde ir depois de entrar). Só caminho interno:
 * começa com "/", não com "//" nem "/\", sem esquema, sem quebra de linha.
 */
export function voltaSegura(valor: unknown, padrao = "/conta"): string {
  if (typeof valor !== "string") return padrao;
  const v = valor.trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.length > 512) return padrao;
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return padrao;
  try {
    // Resolvido contra uma base qualquer, precisa continuar na mesma origem.
    const base = "https://sobedesce.invalid";
    const u = new URL(v, base);
    if (u.origin !== base) return padrao;
    // Voltar para o próprio login ou para o sair daria volta em círculo.
    if (["/entrar", "/criar-conta", "/sair", "/esqueci-a-senha", "/nova-senha"].includes(u.pathname)) return padrao;
    return u.pathname + u.search + u.hash;
  } catch {
    return padrao;
  }
}
