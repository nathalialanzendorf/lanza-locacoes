import { DETRAN_SC_API_BASE, detranScJsonHeaders } from "../src/lib/detranSc/auth.js";
import { compactPlaca } from "../src/lib/placa.js";

const TICKET = process.argv[2];
const TEST_PLACA = process.argv[3]; // ex: AVU-6740
const TEST_RENAVAM = process.argv[4]; // ex: 00480715769

async function fetchResposta(ticket: string): Promise<void> {
  const url = `${DETRAN_SC_API_BASE}/veiculo/resposta-consulta?t=${encodeURIComponent(ticket)}`;
  const r = await fetch(url, { headers: detranScJsonHeaders() });
  const text = await r.text();
  console.log(`[resposta-consulta] HTTP ${r.status}`);
  try {
    const j = JSON.parse(text);
    const o = (j && (j.data || j.veiculo || j.resultado || j)) as any;
    console.log(
      `  placa=${o?.placa ?? "?"} infracoes=${Array.isArray(o?.infracoes) ? o.infracoes.length : "-"} ` +
        `historico=${Array.isArray(o?.historicoInfracoes) ? o.historicoInfracoes.length : "-"} ` +
        `debitos=${Array.isArray(o?.debitos) ? o.debitos.length : "-"}`,
    );
  } catch {
    console.log("  corpo (300):", text.slice(0, 300));
  }
}

async function testCaptchaFree(placa: string, renavam: string): Promise<void> {
  const p = compactPlaca(placa);
  const r = `${renavam}`.replace(/\D/g, "");
  const url = `${DETRAN_SC_API_BASE}/veiculo/requisitar-consulta?p=${encodeURIComponent(p)}&r=${encodeURIComponent(r)}&c=&v=`;
  const resp = await fetch(url, { headers: detranScJsonHeaders() });
  const text = await resp.text();
  console.log(`[requisitar-consulta SEM captcha] ${placa} → HTTP ${resp.status}`);
  console.log("  corpo (300):", text.slice(0, 300));
}

async function main(): Promise<void> {
  if (TICKET) await fetchResposta(TICKET);
  if (TEST_PLACA && TEST_RENAVAM) await testCaptchaFree(TEST_PLACA, TEST_RENAVAM);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
