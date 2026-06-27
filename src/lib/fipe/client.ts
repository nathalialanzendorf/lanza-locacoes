/**
 * Cliente HTTP da API FIPE (parallelum) — camada de baixo nível.
 * Tabela FIPE de carros: https://fipe.parallelum.com.br
 */
import https from "node:https";

export const API_HOST = "fipe.parallelum.com.br";
export const API_BASE = "/api/v2/cars";

const agent = new https.Agent({ rejectUnauthorized: false });

export function fipeGet<T = unknown>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: API_HOST,
      path: API_BASE + path,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LanzaTools/1)" },
      agent,
    };
    https
      .get(opts, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(
              new Error(
                `JSON ${path}: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        });
      })
      .on("error", reject);
  });
}

export type FipeMarca = { code: string; name: string };
export type FipeModelo = { code: string; name: string };
export type FipeAno = { code: string; name: string };
export type FipeValor = {
  brand?: string;
  codeFipe?: string;
  model?: string;
  price?: string;
  modelYear?: string;
  fuel?: string;
  referenceMonth?: string;
};
