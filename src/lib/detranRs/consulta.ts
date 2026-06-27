import { compactPlaca } from "../placa.js";
import { DETRAN_RS_API_BASE, detranRsJsonHeaders } from "./auth.js";

/** Resposta crua do endpoint de consulta de veículo do DETRAN RS. */
export type DetranRsConsultaVeiculo = Record<string, unknown>;

/**
 * Consulta um veículo no DETRAN RS (PROCERGS). Uma única chamada GET — sem
 * ticket/captcha. Retorna o JSON completo (identificação, imposto, licenciamento,
 * infração, seguro, etc.).
 */
export async function consultarVeiculoDetranRs(
  placa: string,
  renavam: string,
): Promise<DetranRsConsultaVeiculo> {
  const placaUrl = compactPlaca(placa);
  const renavamUrl = String(renavam).replace(/\D/g, "");
  const url = `${DETRAN_RS_API_BASE}/veiculos/${encodeURIComponent(placaUrl)}/?renavam=${encodeURIComponent(renavamUrl)}&contabiliza=false`;

  const resp = await fetch(url, { headers: detranRsJsonHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `DETRAN RS consulta ${placaUrl}: HTTP ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  return (await resp.json()) as DetranRsConsultaVeiculo;
}
