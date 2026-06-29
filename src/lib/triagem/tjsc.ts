/**
 * Fonte TJSC — Certidão Criminal estadual (eproc). Padrão gov.br (igual DETRAN).
 *
 * O ÚNICO passo manual é o **login gov.br (prata) + credencial PJSC** na janela
 * (como no solver do DETRAN SC/RS). Depois do login, o harness:
 *   1. detecta o retorno ao domínio `*.tjsc.jus.br`;
 *   2. navega até Certidões → Requisição → modelo Criminal (heurístico);
 *   3. preenche nome, CPF, e-mail de resposta e finalidade (por rótulo);
 *   4. envia a requisição.
 * A certidão volta por **e-mail** (até 5 dias úteis) — anexar ao caso depois.
 *
 * A sessão gov.br fica salva no perfil dedicado do Chrome (USER_DATA_DIR), então
 * execuções seguintes reaproveitam o login. Ver `.cursor/tools/tjsc-certidoes/`.
 */
import type { TriagemBrowser } from "./browser.js";
import { sleep } from "./browser.js";
import type { DadosLocatario, ResultadoFonte } from "./tipos.js";

const PORTAL = "https://certidoes.tjsc.jus.br/";

// Logado quando a aba está estável num host de APP do TJSC (certidoes/app), não
// no SSO/gov.br, e a página já tem conteúdo. Exigimos ESTABILIDADE (várias
// leituras seguidas) porque o login gov.br passa transitoriamente por
// certidoes.tjsc.jus.br durante os redirecionamentos OAuth (falso positivo).
const LOGADO = String.raw`(/(certidoes|app)\.tjsc\.jus\.br$/.test(location.host) && !/^sso\./.test(location.host) && document.body && document.body.innerText.replace(/\s/g,'').length > 80)`;

const agora = (): string => new Date().toISOString();

export interface OpcoesTjsc {
  prompt?: (msg: string) => void;
  timeoutMs?: number;
  emailResposta?: string | null;
  finalidade?: string | null;
}

export async function consultarTjsc(
  browser: TriagemBrowser,
  locatario: DadosLocatario,
  opts: OpcoesTjsc = {},
): Promise<ResultadoFonte> {
  const log = opts.prompt ?? ((m: string) => console.log(m));
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const email = (opts.emailResposta ?? "").trim();
  const finalidade = (opts.finalidade ?? "Análise para locação de veículo").trim();

  const base: ResultadoFonte = {
    id: "tjsc",
    nome: "TJSC — certidão criminal estadual (eproc)",
    status: "assistido",
    alerta: false,
    observacao: "",
    achados: [],
    consultadoEm: agora(),
  };

  let sid: string;
  try {
    sid = await browser.novaAba(PORTAL);
  } catch (e) {
    return {
      ...base,
      status: "erro",
      observacao: `Não consegui abrir o portal do TJSC: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  log("");
  log("== TJSC — Certidão Criminal (eproc) ==");
  log(">> Na aba do TJSC, faça APENAS o LOGIN gov.br (nível prata) + credencial PJSC.");
  log("   Não precisa preencher nada — eu cuido da requisição depois que você logar.");
  log(`(aguardando o login até ${Math.round(timeoutMs / 60000)} min)`);

  // Espera login ESTÁVEL: a condição precisa valer em 3 leituras seguidas (~6s)
  // para não disparar no host transitório durante o redirect do gov.br.
  let estavel = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await browser
      .avaliar<boolean>(`!!(${LOGADO})`, sid)
      .catch(() => false);
    estavel = ok ? estavel + 1 : 0;
    if (estavel >= 3) break;
    if (!(await browser.vivo())) break;
    await sleep(2000);
  }
  const logou = estavel >= 3;
  if (!logou) {
    return {
      ...base,
      status: "assistido",
      consultadoEm: agora(),
      observacao:
        "Login gov.br não concluído no tempo de espera — conclua a requisição da certidão Criminal manualmente no portal do TJSC.",
    };
  }

  await browser.reinjetarHook(sid);
  await sleep(2500);
  log("Login detectado. Mapeando a tela do TJSC...");
  log(`[tjsc snapshot] ${await browser.snapshot(sid)}`);

  // Navegação heurística até a requisição da certidão Criminal.
  const passos: string[][] = [
    ["Certid", "Requisi", "Antecedentes"],
    ["Requisi", "Solicit", "Nova", "Emitir certid"],
    ["Criminal"],
  ];
  for (const padroes of passos) {
    const clk = await browser.clicarTexto(sid, padroes);
    if (clk) log(`TJSC → naveguei para: "${clk}"`);
    await sleep(2500);
    await browser.reinjetarHook(sid);
  }
  log(`[tjsc snapshot form] ${await browser.snapshot(sid)}`);

  // Preenche os campos da requisição por rótulo.
  const fNome = await browser.preencherPorRotulo(sid, "nome", locatario.nome);
  const fCpf = await browser.preencherPorRotulo(sid, "cpf|c\\.p\\.f", locatario.cpf);
  const fEmail = email
    ? await browser.preencherPorRotulo(sid, "e-?mail", email)
    : { ok: false as const };
  const fFinal = await browser.preencherPorRotulo(sid, "finalidad|motiv", finalidade);
  log(
    `TJSC preenchi → nome:${fNome.ok} cpf:${fCpf.ok} email:${fEmail.ok} finalidade:${fFinal.ok}`,
  );

  // Só envia se preencheu ao menos o nome (obrigatório) e o e-mail (quando exigido).
  let enviado = false;
  if (fNome.ok && (fEmail.ok || !email)) {
    await sleep(600);
    const btn = await browser.clicarTexto(sid, [
      "Requisitar",
      "Solicitar",
      "Gerar certid",
      "Emitir certid",
      "Enviar",
      "Confirmar",
    ]);
    if (btn) {
      enviado = true;
      log(`TJSC → enviei a requisição: "${btn}".`);
    }
  }

  return {
    ...base,
    status: "assistido",
    consultadoEm: agora(),
    observacao: enviado
      ? `Requisição da certidão Criminal ENVIADA ao TJSC — resposta por e-mail (${email || "e-mail informado"}) em até 5 dias úteis. Conferir a caixa de entrada e anexar o PDF ao caso.`
      : "Login detectado, mas não consegui preencher/enviar automaticamente. Conclua a requisição da certidão Criminal na janela (Nome, CPF, e-mail e Finalidade).",
  };
}
