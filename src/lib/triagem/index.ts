/**
 * Orquestrador da triagem de locatário.
 *
 * Abre UM Chrome real e roda as fontes selecionadas em sequência (o operador
 * resolve captcha/login em cada aba). Agrega os resultados num relatório.
 *
 * Fontes:
 *   - bnmp     CNJ BNMP (mandados/procurados) — captura da busca por nome.
 *   - pf       PF SINIC (antecedentes nacionais) — captura do PDF.
 *   - tjsc     TJSC certidão criminal — passo assistido (e-mail).
 */
import { TriagemBrowser } from "./browser.js";
import { consultarBnmp } from "./bnmp.js";
import { consultarPfSinic } from "./pfSinic.js";
import { consultarTjsc } from "./tjsc.js";
import type { DadosLocatario, ResultadoFonte } from "./tipos.js";

export type FonteId = "bnmp" | "pf" | "tjsc";

export interface OpcoesTriagem {
  fontes: FonteId[];
  timeoutMin?: number;
  prompt?: (msg: string) => void;
  /** Chamado antes de fechar o Chrome (ex.: aguardar Enter do operador). */
  aguardarFim?: () => Promise<void>;
  /** TJSC: e-mail de resposta e finalidade da requisição da certidão. */
  emailTjsc?: string | null;
  finalidadeTjsc?: string | null;
}

export async function executarTriagem(
  locatario: DadosLocatario,
  opts: OpcoesTriagem,
): Promise<ResultadoFonte[]> {
  const log = opts.prompt ?? ((m: string) => console.log(m));
  const timeoutMs = (opts.timeoutMin ?? 6) * 60 * 1000;
  const resultados: ResultadoFonte[] = [];

  log("Abrindo o Chrome (perfil dedicado da triagem)...");
  const browser = await TriagemBrowser.iniciar();
  log("Chrome aberto. Siga as instruções em cada aba.");

  try {
    if (opts.fontes.includes("bnmp")) {
      resultados.push(await consultarBnmp(browser, locatario, { timeoutMs, prompt: log }));
    }
    if (opts.fontes.includes("pf")) {
      resultados.push(await consultarPfSinic(browser, locatario, { timeoutMs, prompt: log }));
    }
    if (opts.fontes.includes("tjsc")) {
      resultados.push(
        await consultarTjsc(browser, locatario, {
          prompt: log,
          timeoutMs,
          emailResposta: opts.emailTjsc,
          finalidade: opts.finalidadeTjsc,
        }),
      );
    }
  } finally {
    if (opts.aguardarFim) {
      try {
        await opts.aguardarFim();
      } catch {
        /* segue para o fechamento */
      }
    }
    log("");
    log("Fechando o Chrome...");
    await browser.fechar();
  }

  return resultados;
}
