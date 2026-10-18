/**
 * Lógica de /api/google/conectar e /api/google/callback (as rotas só repassam o Request).
 * Erros voltam como ?erro=<codigo> para a tela; os textos estão em src/components/conta/mensagens.ts.
 */
import { COOKIE_APARELHO, conferirAparelho, opcoesCookieAparelho } from "@/lib/auth/aparelho";
import { autenticar, COOKIE_SESSAO, criarSessao, opcoesCookieSessao } from "@/lib/auth/sessao";
import { voltaSegura } from "@/lib/auth/volta";
import { depoisDaResposta, type Depois } from "@/lib/depois";
import { ipDe, lerCookie, lugarDe, origemDoPedido, redirecionar, serializarCookie } from "@/lib/http";
import { cookieSeguro } from "@/lib/site";
import { googleConfigurado, redirectUri } from "./config";
import { criarContaComGoogle, donoDaContaGoogle, vincularConta } from "./contas";
import { chaveConfigurada } from "./cripto";
import { abrirEstado, COOKIE_OAUTH, DURACAO_OAUTH_S, novoState, selarEstado, stateConfere, type ModoGoogle } from "./estado";
import { escopoTemDrive, perfil, pkce, trocarCodigo, urlDeConsentimento, type PerfilGoogle, type Tokens } from "./oauth";

/** Junta um parâmetro a um caminho interno que talvez já tenha "?". */
export function comParametro(caminho: string, chave: string, valor: string): string {
  const u = new URL(caminho, "https://sobedesce.invalid");
  u.searchParams.set(chave, valor);
  return u.pathname + u.search + u.hash;
}

function paginaDeErro(modo: ModoGoogle, volta: string, codigo: string): string {
  if (modo === "entrar") {
    const base = comParametro("/entrar", "erro", codigo);
    return volta !== "/conta" ? comParametro(base, "volta", volta) : base;
  }
  return comParametro(volta, "erro", codigo);
}

export async function conectar(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const modo: ModoGoogle = url.searchParams.get("modo") === "entrar" ? "entrar" : "vincular";
  const volta = voltaSegura(url.searchParams.get("volta"));

  // O Google volta para o endereço cadastrado: o cookie do state precisa nascer nele.
  const retorno = new URL(redirectUri(url.origin));
  if (url.host !== retorno.host) return redirecionar(new URL(url.pathname + url.search, retorno.origin), 307);

  if (!googleConfigurado() || !chaveConfigurada()) return redirecionar(new URL(paginaDeErro(modo, volta, "google_config"), url.origin));

  let usuarioId: string | null = null;
  if (modo === "vincular") {
    const atual = await autenticar({ cookie: lerCookie(req, COOKIE_SESSAO) });
    if (!atual) return redirecionar(new URL(comParametro("/entrar", "volta", volta), url.origin));
    usuarioId = atual.usuario.id;
  }

  const state = novoState();
  const { verificador, desafio } = pkce();
  const cookie = serializarCookie(COOKIE_OAUTH, selarEstado({ state, verificador, modo, usuarioId, volta }), {
    maxAge: DURACAO_OAUTH_S,
    path: "/api/google",
    secure: cookieSeguro(url.origin),
  });
  return redirecionar(urlDeConsentimento({ state, desafio, origem: retorno.origin }), 302, [cookie]);
}

/** `depois`: onde vai o aviso de entrada nova (a rota usa o `after` do Next; os testes passam o deles). */
export async function callback(req: Request, depois: Depois = depoisDaResposta): Promise<Response> {
  const url = new URL(req.url);
  const seguro = cookieSeguro(origemDoPedido(req.headers, req.url));
  const limpar = serializarCookie(COOKIE_OAUTH, "", { maxAge: 0, path: "/api/google", secure: seguro });
  const ir = (caminho: string, cookies: string[] = []) => redirecionar(new URL(caminho, url.origin), 303, [limpar, ...cookies]);

  const estado = abrirEstado(lerCookie(req, COOKIE_OAUTH));
  if (!estado) {
    // Sem o cookie (venceu, outra aba, outro navegador): não dá para saber o modo.
    const logado = await autenticar({ cookie: lerCookie(req, COOKIE_SESSAO) });
    return ir(logado ? "/conta?erro=google_expirou" : "/entrar?erro=google_expirou");
  }
  const { modo, volta } = estado;
  const falhar = (codigo: string) => ir(paginaDeErro(modo, volta, codigo));

  if (!stateConfere(url.searchParams.get("state"), estado.state)) return falhar("google_expirou");
  const erroGoogle = url.searchParams.get("error");
  if (erroGoogle) return falhar(erroGoogle === "access_denied" ? "google_recusado" : "google_erro");
  const code = url.searchParams.get("code");
  if (!code) return falhar("google_erro");

  let tokens: Tokens;
  let quem: PerfilGoogle;
  try {
    tokens = await trocarCodigo(code, estado.verificador, url.origin);
    quem = await perfil(tokens.acesso);
  } catch {
    return falhar("google_erro");
  }
  const temDrive = escopoTemDrive(tokens.escopo);

  if (modo === "vincular") {
    const atual = await autenticar({ cookie: lerCookie(req, COOKIE_SESSAO) });
    if (!atual || atual.usuario.id !== estado.usuarioId) return ir(comParametro("/entrar", "volta", volta));
    if (!temDrive) return falhar("google_sem_drive");
    if (!tokens.refresh) return falhar("google_erro");
    const r = await vincularConta(atual.usuario.id, quem, { ...tokens, refresh: tokens.refresh });
    if (!r.ok) return falhar(r.erro);
    return ir(comParametro(volta, "google", "ok"));
  }

  // Continuar com Google: o Google de entrar de uma conta entra nela; um Google que só está conectado como Drive
  // não abre a conta (revisão A3); um Google novo cria a conta SOBEDESCE com este Drive.
  const entrada = await donoDaContaGoogle(quem, temDrive ? tokens : { ...tokens, refresh: null });
  if (entrada.tipo === "nao_e_login") return falhar("google_nao_e_login");
  let usuarioId = entrada.tipo === "ok" ? entrada.usuarioId : null;
  let criou = false;
  if (!usuarioId) {
    if (!temDrive) return falhar("google_sem_drive");
    if (!tokens.refresh) return falhar("google_erro");
    const novo = await criarContaComGoogle(quem, { ...tokens, refresh: tokens.refresh }, ipDe(req.headers), depois);
    if (!novo.ok) return falhar(novo.erro);
    usuarioId = novo.usuarioId;
    criou = true;
  }
  const sessao = await criarSessao(usuarioId, "web");
  const o = opcoesCookieSessao(seguro);
  const cookieSessao = serializarCookie(COOKIE_SESSAO, sessao.token, { maxAge: o.maxAge, path: o.path, secure: o.secure });
  // Aparelho que a conta ainda não usou: aviso de entrada nova (conta que acabou de nascer só aprende o aparelho).
  const aparelho = await conferirAparelho({
    usuarioId,
    cookie: lerCookie(req, COOKIE_APARELHO),
    via: "google",
    entrada: { userAgent: req.headers.get("user-agent"), lugar: lugarDe(req.headers) },
    avisar: !criou,
    depois,
  });
  const cookies = [cookieSessao];
  if (aparelho) {
    const a = opcoesCookieAparelho(seguro);
    cookies.push(serializarCookie(COOKIE_APARELHO, aparelho, { maxAge: a.maxAge, path: a.path, secure: a.secure }));
  }
  // No celular, quem só entrou (sem pedir outra página) vai direto para o envio.
  const celular = /iPhone|iPad|iPod|Android|Mobile/i.test(req.headers.get("user-agent") ?? "");
  const destino = volta === "/conta" && celular ? "/app/" : criou ? comParametro(volta, "google", "ok") : volta;
  return ir(destino, cookies);
}
