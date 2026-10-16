/** Resend falso: POST /emails com Bearer; guarda o que recebeu. */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type EmailRecebido = { from: string; to: string[]; subject: string; html: string; text: string; authorization: string };

export async function iniciarResendFalso(chave: string, porta = 0) {
  const recebidos: EmailRecebido[] = [];
  let falhar = false;
  const servidor = http.createServer(async (req, res) => {
    const partes: Buffer[] = [];
    for await (const p of req) partes.push(p as Buffer);
    if (req.method === "GET" && req.url === "/__ultimos") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(recebidos));
    }
    if (req.method !== "POST" || req.url !== "/emails") {
      res.writeHead(404);
      return res.end();
    }
    const authorization = req.headers.authorization ?? "";
    if (authorization !== `Bearer ${chave}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ name: "validation_error", message: "API key is invalid" }));
    }
    if (falhar) {
      res.writeHead(500);
      return res.end();
    }
    const corpo = JSON.parse(Buffer.concat(partes).toString("utf8"));
    recebidos.push({ ...corpo, authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: `email-${recebidos.length}` }));
  });
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    recebidos,
    falhar(v: boolean) {
      falhar = v;
    },
    fechar: () => new Promise<void>((ok) => servidor.close(() => ok())),
  };
}
