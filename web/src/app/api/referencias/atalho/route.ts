import { dentroDoLimite, registrarTentativa, REGRAS } from "@/lib/auth/limite";
import { ipDe, lerJson } from "@/lib/http";
import { falha, ok } from "@/lib/referencias/api";
import { donoDoAtalho } from "@/lib/referencias/atalho";
import { acharPorIdOuNome, listarColecoes } from "@/lib/referencias/colecoes";
import { adicionarNaFila } from "@/lib/referencias/fila";
import { limparUrl } from "@/lib/referencias/texto";
import { podeUsar } from "@/lib/recursos";

/** Corpo do Atalho: JSON, formulário ou o link puro como texto. */
async function lerCorpo(req: Request): Promise<Record<string, unknown>> {
  const tipo = req.headers.get("content-type") ?? "";
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(tipo)) {
    try {
      const fd = await req.formData();
      return Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
    } catch {
      return {};
    }
  }
  const j = await lerJson(req.clone());
  if (j) return j;
  const texto = (await req.text().catch(() => "")).slice(0, 4096);
  return texto ? { url: texto } : {};
}

/**
 * Atalho do iPhone: `Authorization: Atalho sda_…` e `{ url, colecao (nome ou id) }`. Só põe o link na fila.
 * Sem `colecao`: vai para a coleção mais recente.
 */
export async function POST(req: Request) {
  const ip = ipDe(req.headers);
  const chaveIp = `atalho-ip:${ip}`;
  if (!(await dentroDoLimite(chaveIp, REGRAS.atalhoErro))) return falha(429, "devagar", "Muitas tentativas com uma chave errada. Espere alguns minutos.");
  const dono = await donoDoAtalho(req.headers.get("authorization"));
  if (!dono) {
    await registrarTentativa(chaveIp);
    return falha(401, "chave", "Chave do Atalho inválida. Gere outra no app SOBEDESCE, em Referências.");
  }
  if (!(await podeUsar(dono.usuario, "referencias"))) return falha(403, "plano", "As Referências fazem parte do plano Produtora.", { motivo: "plano" });
  const chaveUso = `atalho:${dono.atalhoId}`;
  if (!(await dentroDoLimite(chaveUso, REGRAS.atalhoUso))) return falha(429, "devagar", "Muitos links seguidos. Espere um pouco.");
  await registrarTentativa(chaveUso);

  const corpo = await lerCorpo(req);
  const url = limparUrl(corpo.url ?? corpo.link ?? corpo.text ?? corpo.texto);
  if (!url) return falha(400, "url", "Não achei um link no que foi compartilhado.");
  const pedida = typeof corpo.colecao === "string" ? corpo.colecao.trim().slice(0, 100) : "";
  let colecao = pedida ? await acharPorIdOuNome(dono.usuario.id, pedida) : null;
  if (!colecao) {
    const { linhas } = await listarColecoes(dono.usuario.id);
    if (!linhas.length) return falha(409, "sem_colecao", "Crie uma coleção no app SOBEDESCE, em Referências, antes de usar o Atalho.");
    if (pedida) return falha(404, "colecao", `Não achei a coleção “${pedida}”. Suas coleções: ${linhas.map((l) => l.nome).join(", ")}.`);
    colecao = linhas[0];
  }
  const nota = typeof corpo.nota === "string" && corpo.nota.trim() ? corpo.nota.trim().slice(0, 2000) : null;
  const r = await adicionarNaFila(dono.usuario.id, colecao.id, url, nota);
  return ok(
    { mensagem: r.novo ? `Salvo em ${colecao.nome}. O computador baixa.` : `Já estava na fila de ${colecao.nome}.`, colecao: colecao.nome, item: { id: r.item.id, status: r.item.status } },
    r.novo ? 201 : 200,
  );
}
