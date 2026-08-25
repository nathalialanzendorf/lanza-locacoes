import { randomUUID } from "node:crypto";

import { pgQuery } from "../client/PostgresPool.js";
import { pgWriteQuery } from "../client/pgWrite.js";
import { resolveVeiculoIdFromSql } from "./coreRepositories.js";
import {
  asBool,
  asNumber,
  asText,
  compactPlaca,
  formatPlacaHyphen,
  isUuid,
  normCpf,
  parseIso,
  parseIsoOrDataBr,
} from "../migration/relationalUtils.js";

const CATEGORIAS_DESPESA_VENDA = ["Venda entrada", "Venda parcela"];

function autoInfracaoPrefixoVenda(vendaId: string): string {
  return `VENDA-${vendaId.trim().replace(/-/g, "").toUpperCase()}`;
}

async function loadPlacaMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (placaMapCache && now - placaMapCache.at < PLACA_MAP_TTL_MS) {
    return placaMapCache.map;
  }
  const r = await pgQuery<{ id: string; placa_norm: string }>(
    "SELECT id, placa_norm FROM lanza.veiculos",
  );
  const map = new Map<string, string>();
  for (const row of r.rows) map.set(row.placa_norm, row.id);
  placaMapCache = { map, at: now };
  return map;
}

let placaMapCache: { map: Map<string, string>; at: number } | null = null;
const PLACA_MAP_TTL_MS = 5 * 60 * 1000;

let contratoAssinadoColumnsCache: boolean | null = null;
let horaInicioColumnCache: boolean | null = null;
let documentoGeradoColumnsCache: boolean | null = null;
let clienteDocumentoColumnsCache: boolean | null = null;

/** Colunas documento gerado (migration 027) — opcionais até a migration rodar. */
export async function hasDocumentoGeradoColumns(): Promise<boolean> {
  if (documentoGeradoColumnsCache === true) return true;
  const r = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'lanza' AND table_name = 'contratos'
         AND column_name = 'documento_docx_storage_key'
     ) AS exists`,
  );
  const exists = r.rows[0]?.exists === true;
  if (exists) documentoGeradoColumnsCache = true;
  return exists;
}

export async function hasClienteDocumentoColumns(): Promise<boolean> {
  if (clienteDocumentoColumnsCache === true) return true;
  const r = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'lanza' AND table_name = 'clientes'
         AND column_name = 'cnh_storage_key'
     ) AS exists`,
  );
  const exists = r.rows[0]?.exists === true;
  if (exists) clienteDocumentoColumnsCache = true;
  return exists;
}

/** Colunas de upload de contrato assinado (migration 017) — opcionais até a migration rodar. */
export async function hasContratoAssinadoColumns(): Promise<boolean> {
  if (contratoAssinadoColumnsCache === true) return true;
  const r = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'lanza' AND table_name = 'contratos'
         AND column_name = 'contrato_assinado_storage_key'
     ) AS exists`,
  );
  const exists = r.rows[0]?.exists === true;
  if (exists) contratoAssinadoColumnsCache = true;
  return exists;
}

/** Coluna hora_inicio (migration 019) — opcional até a migration rodar. */
export async function hasHoraInicioColumn(): Promise<boolean> {
  if (horaInicioColumnCache === true) return true;
  const r = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'lanza' AND table_name = 'contratos'
         AND column_name = 'hora_inicio'
     ) AS exists`,
  );
  const exists = r.rows[0]?.exists === true;
  if (exists) horaInicioColumnCache = true;
  return exists;
}

function resolveHoraInicio(c: Record<string, unknown>): string {
  return asText(c.horaInicio)?.trim() || "18:00";
}

function resolveVeiculoId(
  ref: string | null | undefined,
  placaMap: Map<string, string>,
): string | null {
  if (!ref) return null;
  if (isUuid(ref)) return ref;
  return placaMap.get(compactPlaca(ref)) ?? null;
}

function rowIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
}

// --- Contratos ---

export type ContratosDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaContrato?: Record<string, string>;
  contratos: Record<string, unknown>[];
};

function mapContratoRow(
  row: Record<string, unknown>,
  cs: Record<string, unknown> | undefined,
  vs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const id = String(row.id);
  const placa = asText(vs?.placa) ?? asText(row.veiculo_placa_ref) ?? undefined;

  return {
    id,
    versao: row.versao,
    contratoAnteriorId: row.contrato_anterior_id,
    clienteId: row.cliente_id,
    veiculoId: row.veiculo_id != null ? String(row.veiculo_id) : null,
    pastaContrato: row.pasta_contrato,
    clienteNome: cs?.nome,
    placa,
    cpf: cs?.cpf,
    dataInicio: row.data_inicio,
    horaInicio: asText(row.hora_inicio) ?? "18:00",
    dataFimPrevista: row.data_fim_prevista,
    dataEncerramento: row.data_encerramento,
    quebraContrato: row.quebra_contrato === true,
    motivoEncerramento: row.motivo_encerramento,
    status: row.status,
    prazoDias: row.prazo_dias,
    tipoContrato: row.tipo_contrato,
    diaPagamentoSemana: row.dia_pagamento_semana,
    diaPagamentoMes: row.dia_pagamento_mes,
    diaPagamentoTexto: row.dia_pagamento_texto,
    valorSemanal: row.valor_semanal != null ? Number(row.valor_semanal) : null,
    valorMensal: row.valor_mensal != null ? Number(row.valor_mensal) : null,
    valorDiaria: row.valor_diaria != null ? Number(row.valor_diaria) : null,
    valorCaucao: Number(row.valor_caucao ?? 0),
    contratoAssinadoStorageKey: asText(row.contrato_assinado_storage_key),
    contratoAssinadoNome: asText(row.contrato_assinado_nome),
    documentoDocxStorageKey: asText(row.documento_docx_storage_key),
    documentoPdfStorageKey: asText(row.documento_pdf_storage_key),
    documentoGeradoEm: rowIso(row.documento_gerado_em),
    documentoGeradoNome: asText(row.documento_gerado_nome),
    cadastradoEm: rowIso(row.cadastrado_em),
    atualizadoEm: rowIso(row.atualizado_em),
    cliente: cs
      ? {
          id: cs.cliente_ref_id,
          nome: cs.nome,
          cpf: cs.cpf,
          rg: cs.rg,
          telefone: cs.telefone,
          email: cs.email,
          cnh: { categoria: cs.cnh_categoria, validade: cs.cnh_validade },
          endereco: {
            cep: cs.endereco_cep,
            logradouro: cs.endereco_logradouro,
            numero: cs.endereco_numero,
            complemento: cs.endereco_complemento,
            bairro: cs.endereco_bairro,
            cidade: cs.endereco_cidade,
            uf: cs.endereco_uf,
          },
        }
      : undefined,
    veiculo: vs
      ? {
          id: row.veiculo_id ?? vs.veiculo_ref_id,
          placa: vs.placa,
          marcaModelo: vs.marca_modelo,
          fipeModelo: vs.fipe_modelo,
          anoModelo: vs.ano_modelo,
          chassi: vs.chassi,
          renavam: vs.renavam,
          cor: vs.cor,
          fipeValor: vs.fipe_valor,
        }
      : undefined,
  };
}

async function loadContratoSnapshotsForIds(ids: string[]): Promise<{
  cliByContrato: Map<string, Record<string, unknown>>;
  veiByContrato: Map<string, Record<string, unknown>>;
}> {
  if (ids.length === 0) {
    return { cliByContrato: new Map(), veiByContrato: new Map() };
  }
  const [cliSnaps, veiSnaps] = await Promise.all([
    pgQuery(
      "SELECT * FROM lanza.contrato_cliente_snapshots WHERE contrato_id = ANY($1::uuid[])",
      [ids],
      "loadContratoSnapshots/cliente",
    ),
    pgQuery(
      "SELECT * FROM lanza.contrato_veiculo_snapshots WHERE contrato_id = ANY($1::uuid[])",
      [ids],
      "loadContratoSnapshots/veiculo",
    ),
  ]);
  return {
    cliByContrato: new Map(cliSnaps.rows.map((row) => [String(row.contrato_id), row])),
    veiByContrato: new Map(veiSnaps.rows.map((row) => [String(row.contrato_id), row])),
  };
}

export type ContratosSqlFilter = {
  id?: string;
  /** Caminho normalizado da pasta do contrato (mutação por pasta). */
  pastaContrato?: string;
  status?: string;
  clienteId?: string;
  /** UUID do veículo (placa deve ser resolvida na camada de listagem). */
  veiculoId?: string;
  /** Contratos de qualquer um destes veículos (atribuição por data do evento). */
  veiculoIds?: string[];
  /** clienteId + veículo no mesmo contrato (AND) — baixa unitária. */
  contratoPar?: boolean;
  /** Não carrega snapshots cliente/veículo (baixa — só valor_semanal/diaria). */
  skipSnapshots?: boolean;
};

/** Listagem filtrada no Postgres (carrega snapshots só dos contratos retornados). */
export async function queryContratosFromSql(
  filter: ContratosSqlFilter = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  if (filter.id?.trim() && isUuid(filter.id.trim())) {
    params.push(filter.id.trim());
    where.push(`c.id::text = $${p++}`);
  }

  if (!filter.id?.trim() && filter.pastaContrato?.trim()) {
    params.push(filter.pastaContrato.trim());
    where.push(`lower(c.pasta_contrato) = $${p++}`);
  }

  if (filter.status?.trim()) {
    params.push(filter.status.trim());
    where.push(`c.status = $${p++}`);
  }

  const scopeParts: string[] = [];
  if (filter.clienteId?.trim() && isUuid(filter.clienteId.trim())) {
    params.push(filter.clienteId.trim());
    scopeParts.push(`c.cliente_id::text = $${p++}`);
  }

  const veiculoIds = [
    ...(filter.veiculoIds ?? []).map((id) => id.trim()).filter((id) => isUuid(id)),
    ...(filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim()) ? [filter.veiculoId.trim()] : []),
  ];
  const uniqueVeiculoIds = [...new Set(veiculoIds)];
  if (uniqueVeiculoIds.length === 1) {
    params.push(uniqueVeiculoIds[0]);
    scopeParts.push(`c.veiculo_id::text = $${p++}`);
  } else if (uniqueVeiculoIds.length > 1) {
    params.push(uniqueVeiculoIds);
    scopeParts.push(`c.veiculo_id::text = ANY($${p++}::text[])`);
  }

  if (scopeParts.length === 1) {
    where.push(scopeParts[0]!);
  } else if (scopeParts.length > 1) {
    const join = filter.contratoPar === true ? " AND " : " OR ";
    where.push(`(${scopeParts.join(join)})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = await pgQuery(
    `SELECT c.*, v.placa AS veiculo_placa_ref
     FROM lanza.contratos c
     LEFT JOIN lanza.veiculos v ON v.id = c.veiculo_id
     ${whereSql}
     ORDER BY c.cadastrado_em`,
    params,
    "queryContratosFromSql",
  );

  const ids = base.rows.map((row) => String(row.id));
  const { cliByContrato, veiByContrato } = filter.skipSnapshots
    ? { cliByContrato: new Map<string, Record<string, unknown>>(), veiByContrato: new Map<string, Record<string, unknown>>() }
    : await loadContratoSnapshotsForIds(ids);

  return base.rows.map((row) => {
    const id = String(row.id);
    return mapContratoRow(
      row as Record<string, unknown>,
      cliByContrato.get(id),
      veiByContrato.get(id),
    );
  });
}

export async function loadContratosFromSql(): Promise<ContratosDbShape> {
  const contratos = await queryContratosFromSql();
  return {
    descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    contratos,
  };
}

async function upsertContratoRowToSql(
  c: Record<string, unknown>,
  placaMap: Map<string, string>,
): Promise<void> {
    const id = asText(c.id) ?? randomUUID();
    const veiculoRef = asText(c.veiculoId) ?? asText(c.placa) ?? "";
    const placa = formatPlacaHyphen(asText(c.placa) ?? veiculoRef);
    const storageKey = asText(c.contratoAssinadoStorageKey);
    const assinadoNome = asText(c.contratoAssinadoNome);
    const hasAssinadoCols = await hasContratoAssinadoColumns();
    const hasHoraCol = await hasHoraInicioColumn();
    if (!hasAssinadoCols && (storageKey || assinadoNome)) {
      throw new Error(
        "Upload de contrato assinado indisponível — execute a migration 017_contrato_assinado.sql no PostgreSQL.",
      );
    }

    const baseParams: unknown[] = [
      id,
      asNumber(c.versao, 1),
      isUuid(asText(c.contratoAnteriorId)) ? c.contratoAnteriorId : null,
      isUuid(asText(c.clienteId)) ? c.clienteId : null,
      resolveVeiculoId(veiculoRef, placaMap),
      asText(c.pastaContrato),
      asText(c.dataInicio) ?? "",
      asText(c.dataFimPrevista) ?? "",
      asText(c.dataEncerramento),
      asBool(c.quebraContrato, false),
      asText(c.motivoEncerramento),
      asText(c.status) ?? "ativo",
      asNumber(c.prazoDias, 0),
      asText(c.tipoContrato) ?? "semanal",
      asText(c.diaPagamentoSemana),
      typeof c.diaPagamentoMes === "number" ? c.diaPagamentoMes : null,
      asText(c.diaPagamentoTexto),
      c.valorSemanal != null ? asNumber(c.valorSemanal) : null,
      c.valorMensal != null ? asNumber(c.valorMensal) : null,
      c.valorDiaria != null ? asNumber(c.valorDiaria) : null,
      asNumber(c.valorCaucao, 0),
    ];
    const horaInicio = resolveHoraInicio(c);

    const horaSql = hasHoraCol ? ", hora_inicio" : "";
    const horaPlaceholder = hasHoraCol ? `,$${baseParams.length + 1}` : "";
    const horaUpdate = hasHoraCol ? ", hora_inicio = EXCLUDED.hora_inicio" : "";
    const horaParams = hasHoraCol ? [horaInicio] : [];

    if (hasAssinadoCols) {
      await pgQuery(
        `INSERT INTO lanza.contratos (
          id, versao, contrato_anterior_id, cliente_id, veiculo_id,
          pasta_contrato, data_inicio, data_fim_prevista,
          data_encerramento, quebra_contrato, motivo_encerramento, status, prazo_dias,
          tipo_contrato, dia_pagamento_semana, dia_pagamento_mes, dia_pagamento_texto,
          valor_semanal, valor_mensal, valor_diaria, valor_caucao${horaSql},
          contrato_assinado_storage_key, contrato_assinado_nome,
          cadastrado_em, atualizado_em
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21${horaPlaceholder},$${baseParams.length + horaParams.length + 1},$${baseParams.length + horaParams.length + 2},
          COALESCE($${baseParams.length + horaParams.length + 3}::timestamptz, now()), now())
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          data_inicio = EXCLUDED.data_inicio,
          data_fim_prevista = EXCLUDED.data_fim_prevista,
          data_encerramento = EXCLUDED.data_encerramento,
          quebra_contrato = EXCLUDED.quebra_contrato,
          motivo_encerramento = EXCLUDED.motivo_encerramento,
          prazo_dias = EXCLUDED.prazo_dias,
          tipo_contrato = EXCLUDED.tipo_contrato,
          dia_pagamento_semana = EXCLUDED.dia_pagamento_semana,
          dia_pagamento_mes = EXCLUDED.dia_pagamento_mes,
          dia_pagamento_texto = EXCLUDED.dia_pagamento_texto,
          valor_semanal = EXCLUDED.valor_semanal,
          valor_mensal = EXCLUDED.valor_mensal,
          valor_diaria = EXCLUDED.valor_diaria,
          valor_caucao = EXCLUDED.valor_caucao${horaUpdate},
          contrato_assinado_storage_key = COALESCE(
            EXCLUDED.contrato_assinado_storage_key,
            lanza.contratos.contrato_assinado_storage_key
          ),
          contrato_assinado_nome = COALESCE(
            EXCLUDED.contrato_assinado_nome,
            lanza.contratos.contrato_assinado_nome
          ),
          atualizado_em = now()`,
        [...baseParams, ...horaParams, storageKey, assinadoNome, parseIso(asText(c.cadastradoEm))],
      );
    } else {
      await pgQuery(
        `INSERT INTO lanza.contratos (
          id, versao, contrato_anterior_id, cliente_id, veiculo_id,
          pasta_contrato, data_inicio, data_fim_prevista,
          data_encerramento, quebra_contrato, motivo_encerramento, status, prazo_dias,
          tipo_contrato, dia_pagamento_semana, dia_pagamento_mes, dia_pagamento_texto,
          valor_semanal, valor_mensal, valor_diaria, valor_caucao${horaSql},
          cadastrado_em, atualizado_em
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21${horaPlaceholder},
          COALESCE($${baseParams.length + horaParams.length + 1}::timestamptz, now()), now())
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          data_inicio = EXCLUDED.data_inicio,
          data_fim_prevista = EXCLUDED.data_fim_prevista,
          data_encerramento = EXCLUDED.data_encerramento,
          quebra_contrato = EXCLUDED.quebra_contrato,
          motivo_encerramento = EXCLUDED.motivo_encerramento,
          prazo_dias = EXCLUDED.prazo_dias,
          tipo_contrato = EXCLUDED.tipo_contrato,
          dia_pagamento_semana = EXCLUDED.dia_pagamento_semana,
          dia_pagamento_mes = EXCLUDED.dia_pagamento_mes,
          dia_pagamento_texto = EXCLUDED.dia_pagamento_texto,
          valor_semanal = EXCLUDED.valor_semanal,
          valor_mensal = EXCLUDED.valor_mensal,
          valor_diaria = EXCLUDED.valor_diaria,
          valor_caucao = EXCLUDED.valor_caucao${horaUpdate},
          atualizado_em = now()`,
        [...baseParams, ...horaParams, parseIso(asText(c.cadastradoEm))],
      );
    }
    const cli = c.cliente as Record<string, unknown> | undefined;
    const end = cli?.endereco as Record<string, unknown> | undefined;
    const cnh = cli?.cnh as Record<string, unknown> | undefined;
    await pgQuery(
      `INSERT INTO lanza.contrato_cliente_snapshots (
        contrato_id, cliente_ref_id, nome, cpf, rg, telefone, email,
        cnh_categoria, cnh_validade, endereco_cep, endereco_logradouro, endereco_numero,
        endereco_complemento, endereco_bairro, endereco_cidade, endereco_uf, atualizado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      ON CONFLICT (contrato_id) DO UPDATE SET
        nome = EXCLUDED.nome,
        cpf = EXCLUDED.cpf,
        atualizado_em = now()`,
      [
        id,
        isUuid(asText(cli?.id ?? c.clienteId)) ? (cli?.id ?? c.clienteId) : null,
        asText(cli?.nome ?? c.clienteNome) ?? "?",
        asText(cli?.cpf ?? c.cpf),
        cli ? asText(cli.rg) : null,
        cli ? asText(cli.telefone) : null,
        cli ? asText(cli.email) : null,
        cnh ? asText(cnh.categoria) : null,
        cnh ? asText(cnh.validade) : null,
        end ? asText(end.cep) : null,
        end ? asText(end.logradouro) : null,
        end ? asText(end.numero) : null,
        end ? asText(end.complemento) : null,
        end ? asText(end.bairro) : null,
        end ? asText(end.cidade) : null,
        end ? asText(end.uf) : null,
      ],
    );
    const vei = c.veiculo as Record<string, unknown> | undefined;
    await pgQuery(
      `INSERT INTO lanza.contrato_veiculo_snapshots (
        contrato_id, veiculo_ref_id, placa, marca_modelo, fipe_modelo, ano_modelo,
        chassi, renavam, cor, fipe_valor, atualizado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT (contrato_id) DO UPDATE SET placa = EXCLUDED.placa, atualizado_em = now()`,
      [
        id,
        isUuid(asText(vei?.id)) ? vei?.id : null,
        formatPlacaHyphen(asText(vei?.placa) ?? placa),
        vei ? asText(vei.marcaModelo) : null,
        vei ? asText(vei.fipeModelo) : null,
        vei ? asText(vei.anoModelo) : null,
        vei ? asText(vei.chassi) : null,
        vei ? asText(vei.renavam) : null,
        vei ? asText(vei.cor) : null,
        vei ? asText(vei.fipeValor) : null,
      ],
    );

    if (await hasDocumentoGeradoColumns()) {
      const docxKey = asText(c.documentoDocxStorageKey);
      const pdfKey = asText(c.documentoPdfStorageKey);
      const geradoEm = parseIso(asText(c.documentoGeradoEm));
      const geradoNome = asText(c.documentoGeradoNome);
      if (docxKey || pdfKey || geradoEm || geradoNome) {
        await pgQuery(
          `UPDATE lanza.contratos SET
            documento_docx_storage_key = COALESCE($2, documento_docx_storage_key),
            documento_pdf_storage_key = COALESCE($3, documento_pdf_storage_key),
            documento_gerado_em = COALESCE($4::timestamptz, documento_gerado_em),
            documento_gerado_nome = COALESCE($5, documento_gerado_nome),
            atualizado_em = now()
          WHERE id = $1`,
          [id, docxKey, pdfKey, geradoEm, geradoNome],
        );
      }
    }
}

/** Grava ou atualiza um único contrato no Postgres (sem reescrever toda a tabela). */
export async function upsertContratoToSql(c: Record<string, unknown>): Promise<void> {
  const veiculoRef = asText(c.veiculoId) ?? asText(c.placa) ?? "";
  const placaMap =
    veiculoRef && isUuid(veiculoRef) ? null : await loadPlacaMap();
  await upsertContratoRowToSql(c, placaMap ?? new Map());
}

/** Remove um contrato do Postgres (snapshots em CASCADE). */
export async function deleteContratoFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.contratos WHERE id = $1`, [id.trim()]);
  return (r.rowCount ?? 0) > 0;
}

export async function saveContratosToSql(db: ContratosDbShape): Promise<void> {
  const placaMap = await loadPlacaMap();
  for (const c of db.contratos) {
    await upsertContratoRowToSql(c as Record<string, unknown>, placaMap);
  }
}

// --- Locações ---

export type LocacoesDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaLocacao?: Record<string, string>;
  locacoes: Record<string, unknown>[];
};

function mapLocacaoRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    veiculoId: row.veiculo_id ?? null,
    placa: row.placa,
    clienteId: row.cliente_id ?? null,
    condutorNome: row.condutor_nome ?? null,
    contratoId: row.contrato_id ?? null,
    situacao: row.situacao,
    inicio: row.inicio,
    fim: row.fim ?? null,
    tipoLocacao: row.tipo_locacao ?? null,
    valorCobrado: row.valor_cobrado != null ? Number(row.valor_cobrado) : null,
    valorPago: row.valor_pago != null ? Number(row.valor_pago) : null,
    substituiVeiculoId: row.substitui_veiculo_id ?? null,
    substituiPlaca: row.substitui_placa ?? null,
    observacao: row.observacao ?? null,
    cadastradoEm: rowIso(row.cadastrado_em),
    atualizadoEm: rowIso(row.atualizado_em),
  };
}

export type LocacoesSqlFilter = {
  /** UUID do veículo (placa deve ser resolvida na camada de listagem). */
  veiculoId?: string;
  clienteId?: string;
  situacao?: string;
  abertas?: boolean;
};

/** Listagem filtrada no Postgres (período BR continua no app). */
export async function queryLocacoesFromSql(
  filter: LocacoesSqlFilter = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  if (filter.clienteId?.trim() && isUuid(filter.clienteId.trim())) {
    params.push(filter.clienteId.trim());
    where.push(`l.cliente_id::text = $${p++}`);
  }

  if (filter.situacao?.trim()) {
    params.push(filter.situacao.trim());
    where.push(`l.situacao = $${p++}`);
  }

  if (filter.abertas === true) {
    where.push(`(l.fim IS NULL OR trim(l.fim) = '')`);
  }

  if (filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim())) {
    params.push(filter.veiculoId.trim());
    where.push(`l.veiculo_id::text = $${p++}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await pgQuery(
    `SELECT l.*
     FROM lanza.locacoes l
     ${whereSql}
     ORDER BY l.inicio, l.cadastrado_em`,
    params,
  );
  return r.rows.map((row) => mapLocacaoRow(row as Record<string, unknown>));
}

export async function loadLocacoesFromSql(): Promise<LocacoesDbShape> {
  return {
    descricao: "Linha do tempo de locação/reserva/manutenção.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    locacoes: await queryLocacoesFromSql(),
  };
}

async function upsertLocacaoRowToSql(
  l: Record<string, unknown>,
  placaMap: Map<string, string>,
): Promise<void> {
  const id = asText(l.id) ?? randomUUID();
  await pgQuery(
    `INSERT INTO lanza.locacoes (
      id, veiculo_id, placa, cliente_id, condutor_nome, contrato_id, situacao, inicio, fim,
      tipo_locacao, valor_cobrado, valor_pago, substitui_veiculo_id, substitui_placa, observacao,
      cadastrado_em, atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz, now()), now())
    ON CONFLICT (id) DO UPDATE SET
      veiculo_id = EXCLUDED.veiculo_id,
      placa = EXCLUDED.placa,
      cliente_id = EXCLUDED.cliente_id,
      condutor_nome = EXCLUDED.condutor_nome,
      contrato_id = EXCLUDED.contrato_id,
      situacao = EXCLUDED.situacao,
      inicio = EXCLUDED.inicio,
      fim = EXCLUDED.fim,
      tipo_locacao = EXCLUDED.tipo_locacao,
      valor_cobrado = EXCLUDED.valor_cobrado,
      valor_pago = EXCLUDED.valor_pago,
      substitui_veiculo_id = EXCLUDED.substitui_veiculo_id,
      substitui_placa = EXCLUDED.substitui_placa,
      observacao = EXCLUDED.observacao,
      atualizado_em = now()`,
    [
      id,
      resolveVeiculoId(asText(l.veiculoId), placaMap),
      formatPlacaHyphen(asText(l.placa) ?? ""),
      isUuid(asText(l.clienteId)) ? l.clienteId : null,
      asText(l.condutorNome),
      isUuid(asText(l.contratoId)) ? l.contratoId : null,
      asText(l.situacao) ?? "locado",
      asText(l.inicio) ?? "",
      asText(l.fim),
      asText(l.tipoLocacao),
      l.valorCobrado != null ? asNumber(l.valorCobrado) : null,
      l.valorPago != null ? asNumber(l.valorPago) : null,
      resolveVeiculoId(asText(l.substituiVeiculoId), placaMap),
      asText(l.substituiPlaca),
      asText(l.observacao),
      parseIso(asText(l.cadastradoEm)),
    ],
  );
}

/** Grava ou atualiza uma única locação no Postgres (sem reescrever toda a tabela). */
export async function upsertLocacaoToSql(l: Record<string, unknown>): Promise<void> {
  const placaMap = await loadPlacaMap();
  await upsertLocacaoRowToSql(l, placaMap);
}

/** Remove uma locação do Postgres. */
export async function deleteLocacaoFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.locacoes WHERE id = $1`, [id.trim()]);
  return (r.rowCount ?? 0) > 0;
}

export async function saveLocacoesToSql(db: LocacoesDbShape): Promise<void> {
  const placaMap = await loadPlacaMap();
  for (const l of db.locacoes) {
    await upsertLocacaoRowToSql(l, placaMap);
  }
}

// --- Infrações ---

export type InfracoesDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaInfracao?: Record<string, string>;
  infracoes: Record<string, unknown>[];
};

function mapInfracaoRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    numeroAuto: row.numero_auto,
    idAutoInfracao: row.id_auto_infracao,
    veiculoId: row.veiculo_id != null ? String(row.veiculo_id) : null,
    descricao: row.descricao,
    dataAutuacao: row.data_autuacao,
    dataHoraAutuacao: row.data_hora_autuacao,
    localInfracao: row.local_infracao,
    valor: Number(row.valor),
    valorMulta: Number(row.valor),
    situacao: row.situacao,
    status: row.status,
    protocolo: row.protocolo,
    dataLimiteDefesa: row.data_limite_defesa,
    limiteDefesa: row.limite_defesa,
    prazoDefesaExpirado: row.prazo_defesa_expirado === true,
    dataVencimentoOriginal: row.data_vencimento_original,
    convertidaEmDebito: row.convertida_em_debito === true,
    quitadaDetran: row.quitada_detran === true,
    statusInfracao: row.status_infracao,
    statusDetran: row.status_detran,
    fonte: row.fonte,
    condutorId: row.condutor_id,
    condutorConfirmado: row.condutor_confirmado === true,
    condutorContrato: row.condutor_contrato,
    condutorNaoIdentificado: row.condutor_nao_identificado === true,
    pdfArquivo: row.pdf_arquivo,
    complemento: row.complemento,
    senhaDetran: row.senha_detran,
    notificacaoPdfArquivo: row.notificacao_pdf_arquivo,
    detranRaw: row.detran_raw,
    origem: row.origem,
    syncEm: rowIso(row.sync_em),
    ativo: row.ativo !== false,
    cadastradoEm: rowIso(row.cadastrado_em),
    atualizadoEm: rowIso(row.atualizado_em),
  };
}

export type InfracoesSqlFilter = {
  /** UUID do veículo (placa deve ser resolvida na camada de listagem). */
  veiculoId?: string;
  clienteId?: string;
  parceiroId?: string;
  emAberto?: boolean;
  semCliente?: boolean;
  ativo?: boolean;
};

/** Listagem filtrada no Postgres (período BR continua no app). */
export async function queryInfracoesFromSql(
  filter: InfracoesSqlFilter = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  if (filter.ativo === true) {
    where.push("(i.ativo IS DISTINCT FROM false)");
  } else if (filter.ativo === false) {
    where.push("(i.ativo = false)");
  }

  if (filter.emAberto === true) {
    where.push(`(
      COALESCE(i.quitada_detran, false) IS NOT TRUE
      AND COALESCE(i.situacao, '') !~* 'quitad|pago|paga'
      AND COALESCE(i.status, '') !~* 'quitad|pago|paga'
    )`);
  } else if (filter.emAberto === false) {
    where.push(`(
      i.quitada_detran = true
      OR COALESCE(i.situacao, '') ~* 'quitad|pago|paga'
      OR COALESCE(i.status, '') ~* 'quitad|pago|paga'
    )`);
  }

  if (filter.semCliente === true) {
    where.push(`NOT (
      COALESCE(i.quitada_detran, false) = true
      OR (i.condutor_confirmado = true AND i.condutor_id IS NOT NULL)
      OR (i.condutor_confirmado = true AND COALESCE(i.condutor_nao_identificado, false) = true)
    )`);
  }

  if (filter.clienteId?.trim() && isUuid(filter.clienteId.trim())) {
    params.push(filter.clienteId.trim());
    where.push(`i.condutor_id::text = $${p++}`);
  }

  if (filter.parceiroId?.trim() && isUuid(filter.parceiroId.trim())) {
    params.push(filter.parceiroId.trim());
    where.push(`EXISTS (
      SELECT 1
      FROM lanza.parceiro_veiculo_vinculos pv
      WHERE pv.parceiro_id::text = $${p}
        AND pv.veiculo_id = i.veiculo_id
    )`);
    p += 1;
  }

  if (filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim())) {
    params.push(filter.veiculoId.trim());
    where.push(`i.veiculo_id::text = $${p++}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await pgQuery(
    `SELECT i.*, v.placa AS veiculo_placa_ref
     FROM lanza.infracoes i
     LEFT JOIN lanza.veiculos v ON v.id = i.veiculo_id
     ${whereSql}
     ORDER BY i.data_autuacao`,
    params,
  );
  return r.rows.map((row) => mapInfracaoRow(row as Record<string, unknown>));
}

export async function loadInfracoesFromSql(): Promise<InfracoesDbShape> {
  return {
    descricao: "Infrações DETRAN SC.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    infracoes: await queryInfracoesFromSql(),
  };
}

async function upsertInfracaoRowToSql(
  i: Record<string, unknown>,
  placaMap: Map<string, string>,
): Promise<void> {
  const id = asText(i.id) ?? randomUUID();
  const raw = i.detranRaw as Record<string, unknown> | undefined;
  const complemento = asText(i.complemento) ?? asText(raw?.complemento);
  const senhaDetran = asText(i.senhaDetran) ?? asText(i.senha) ?? asText(raw?.senha);

  await pgQuery(
    `INSERT INTO lanza.infracoes (
      id, numero_auto, id_auto_infracao, veiculo_id, descricao, data_autuacao,
      data_hora_autuacao, local_infracao, valor, situacao, status, protocolo,
      data_limite_defesa, limite_defesa, prazo_defesa_expirado, data_vencimento_original,
      convertida_em_debito, quitada_detran, status_infracao, status_detran, fonte,
      condutor_id, condutor_confirmado, condutor_contrato, condutor_nao_identificado,
      pdf_arquivo, detran_raw, origem, sync_em, ativo, cadastrado_em, atualizado_em,
      complemento, senha_detran, notificacao_pdf_arquivo
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
      $22,$23,$24,$25,$26,$27,$28,$29,$30,
      COALESCE($31::timestamptz, now()), now(),
      $32,$33,$34)
    ON CONFLICT (id) DO UPDATE SET
      numero_auto = EXCLUDED.numero_auto,
      id_auto_infracao = EXCLUDED.id_auto_infracao,
      veiculo_id = EXCLUDED.veiculo_id,
      descricao = EXCLUDED.descricao,
      data_autuacao = EXCLUDED.data_autuacao,
      data_hora_autuacao = EXCLUDED.data_hora_autuacao,
      local_infracao = EXCLUDED.local_infracao,
      valor = EXCLUDED.valor,
      situacao = EXCLUDED.situacao,
      status = EXCLUDED.status,
      protocolo = EXCLUDED.protocolo,
      data_limite_defesa = EXCLUDED.data_limite_defesa,
      limite_defesa = EXCLUDED.limite_defesa,
      prazo_defesa_expirado = EXCLUDED.prazo_defesa_expirado,
      data_vencimento_original = EXCLUDED.data_vencimento_original,
      convertida_em_debito = EXCLUDED.convertida_em_debito,
      quitada_detran = EXCLUDED.quitada_detran,
      status_infracao = EXCLUDED.status_infracao,
      status_detran = EXCLUDED.status_detran,
      fonte = EXCLUDED.fonte,
      condutor_id = EXCLUDED.condutor_id,
      condutor_confirmado = EXCLUDED.condutor_confirmado,
      condutor_contrato = EXCLUDED.condutor_contrato,
      condutor_nao_identificado = EXCLUDED.condutor_nao_identificado,
      pdf_arquivo = EXCLUDED.pdf_arquivo,
      detran_raw = EXCLUDED.detran_raw,
      origem = EXCLUDED.origem,
      sync_em = EXCLUDED.sync_em,
      ativo = EXCLUDED.ativo,
      complemento = EXCLUDED.complemento,
      senha_detran = EXCLUDED.senha_detran,
      notificacao_pdf_arquivo = EXCLUDED.notificacao_pdf_arquivo,
      atualizado_em = now()`,
    [
      id,
      asText(i.numeroAuto) ?? id,
      typeof i.idAutoInfracao === "number" ? i.idAutoInfracao : null,
      resolveVeiculoId(asText(i.veiculoId), placaMap),
      asText(i.descricao) ?? "",
      asText(i.dataAutuacao) ?? "",
      asText(i.dataHoraAutuacao),
      asText(i.localInfracao),
      asNumber(i.valor ?? i.valorMulta, 0),
      asText(i.situacao),
      asText(i.status),
      asText(i.protocolo),
      asText(i.dataLimiteDefesa),
      asText(i.limiteDefesa),
      asBool(i.prazoDefesaExpirado, false),
      asText(i.dataVencimentoOriginal),
      asBool(i.convertidaEmDebito, false),
      asBool(i.quitadaDetran, false),
      asText(i.statusInfracao),
      asText(i.statusDetran),
      asText(i.fonte),
      isUuid(asText(i.condutorId)) ? i.condutorId : null,
      asBool(i.condutorConfirmado, false),
      asText(i.condutorContrato),
      asBool(i.condutorNaoIdentificado, false),
      asText(i.pdfArquivo),
      i.detranRaw != null ? (i.detranRaw as object) : null,
      asText(i.origem),
      parseIso(asText(i.syncEm)),
      asBool(i.ativo, true),
      parseIso(asText(i.cadastradoEm)),
      complemento,
      senhaDetran,
      asText(i.notificacaoPdfArquivo),
    ],
  );
}

/** Grava ou atualiza uma única infração no Postgres (sem reescrever toda a tabela). */
export async function upsertInfracaoToSql(i: Record<string, unknown>): Promise<void> {
  const placaMap = await loadPlacaMap();
  await upsertInfracaoRowToSql(i, placaMap);
}

export async function saveInfracoesToSql(db: InfracoesDbShape): Promise<void> {
  const placaMap = await loadPlacaMap();
  for (const i of db.infracoes) {
    await upsertInfracaoRowToSql(i, placaMap);
  }
}

// --- Cliente despesas ---

export type ClienteDespesasDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaClienteDespesa?: Record<string, string>;
  clienteDespesas: Record<string, unknown>[];
};

export type ClienteDespesasSqlFilter = {
  clienteId?: string;
  /** UUID do veículo (placa deve ser resolvida na camada de listagem). */
  veiculoId?: string;
  emAberto?: boolean;
  /** Filtro canónico: em_aberto | pago | baixado. */
  statusCobranca?: "em_aberto" | "pago" | "baixado";
  ativo?: boolean;
  categoria?: string;
  /** Filtro ILIKE em descricao (ex.: ATRASADO). */
  descricaoIlike?: string;
  limit?: number;
  /** true = só venda; false = exclui venda */
  moduloVenda?: boolean;
  /** auto_infracao prefixo VENDA-{uuid}-* */
  vendaId?: string;
};

function mapClienteDespesaRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    categoria: row.categoria,
    veiculoId: row.veiculo_id != null ? String(row.veiculo_id) : null,
    autoInfracao: row.auto_infracao,
    titulo: row.titulo,
    descricao: row.descricao,
    numeroAuto: row.numero_auto,
    localInfracao: row.local_infracao,
    dataAutuacao: row.data_autuacao,
    valorMulta: Number(row.valor_multa),
    situacao: row.situacao,
    limiteDefesa: row.limite_defesa,
    dataLimiteDefesa: row.data_limite_defesa,
    dataVencimentoOriginal: row.data_vencimento_original,
    convertidaEmDebito: row.convertida_em_debito === true,
    condutorId: asText(row.condutor_id),
    condutorConfirmado: row.condutor_confirmado === true,
    condutorContrato: row.condutor_contrato,
    condutorNaoIdentificado: row.condutor_nao_identificado === true,
    debitoParceiroConfirmado: row.debito_parceiro_confirmado === true,
    debitoParceiroId: asText(row.debito_parceiro_id),
    revisarManual: row.revisar_manual === true,
    revisarMotivo: row.revisar_motivo,
    paga: row.paga === true,
    statusCobranca:
      row.status_cobranca === "pago" ||
      row.status_cobranca === "baixado" ||
      row.status_cobranca === "em_aberto"
        ? row.status_cobranca
        : row.paga === true
          ? "pago"
          : "em_aberto",
    pagaEm: rowIso(row.paga_em),
    quitadaDetran: row.quitada_detran === true,
    statusInfracao: row.status_infracao,
    statusDetran: row.status_detran,
    rastreameId: row.rastreame_id,
    rastreameMotoristaKey: row.rastreame_motorista_key,
    rastreameRastreavelKey: row.rastreame_rastreavel_key,
    rastreameDataIso: rowIso(row.rastreame_data_iso),
    rastreameTipo: row.rastreame_tipo,
    rastreameSyncEm: rowIso(row.rastreame_sync_em),
    detranAutoInfracao: row.detran_auto_infracao,
    pdfArquivo: row.pdf_arquivo,
    ativo: row.ativo !== false,
    origem: row.origem,
    cadastradoEm: rowIso(row.cadastrado_em),
    atualizadoEm: rowIso(row.atualizado_em),
  };
}

/** Listagem filtrada no Postgres (evita carregar todas as despesas em memória). */
export async function queryClienteDespesasFromSql(
  filter: ClienteDespesasSqlFilter = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  if (filter.ativo === false) {
    where.push("(cd.ativo = false)");
  } else {
    where.push("(cd.ativo IS DISTINCT FROM false)");
  }

  if (filter.statusCobranca === "em_aberto") {
    where.push(
      `(COALESCE(cd.status_cobranca, CASE WHEN cd.paga THEN 'pago' ELSE 'em_aberto' END) = 'em_aberto')`,
    );
  } else if (filter.statusCobranca === "pago") {
    where.push(
      `(COALESCE(cd.status_cobranca, CASE WHEN cd.paga THEN 'pago' ELSE 'em_aberto' END) = 'pago')`,
    );
  } else if (filter.statusCobranca === "baixado") {
    where.push(`(cd.status_cobranca = 'baixado')`);
  } else if (filter.emAberto === true) {
    where.push(
      `(cd.paga IS NOT TRUE AND COALESCE(cd.status_cobranca, 'em_aberto') <> 'baixado')`,
    );
  } else if (filter.emAberto === false) {
    where.push(`(cd.paga = true OR cd.status_cobranca = 'pago')`);
  }

  if (filter.clienteId?.trim() && isUuid(filter.clienteId.trim())) {
    params.push(filter.clienteId.trim());
    where.push(`cd.condutor_id::text = $${p++}`);
  }

  if (filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim())) {
    params.push(filter.veiculoId.trim());
    where.push(`cd.veiculo_id::text = $${p++}`);
  }

  if (filter.categoria?.trim()) {
    params.push(filter.categoria.trim());
    where.push(`cd.categoria = $${p++}`);
  }

  if (filter.moduloVenda === true) {
    params.push(CATEGORIAS_DESPESA_VENDA);
    where.push(`cd.categoria = ANY($${p++}::text[])`);
  } else if (filter.moduloVenda === false) {
    params.push(CATEGORIAS_DESPESA_VENDA);
    where.push(`(cd.categoria IS NULL OR NOT (cd.categoria = ANY($${p++}::text[])))`);
  }

  if (filter.vendaId?.trim()) {
    const prefix = `${autoInfracaoPrefixoVenda(filter.vendaId.trim())}-%`;
    params.push(prefix);
    where.push(`cd.auto_infracao ILIKE $${p++}`);
  }

  if (filter.descricaoIlike?.trim()) {
    params.push(`%${filter.descricaoIlike.trim()}%`);
    where.push(`cd.descricao ILIKE $${p++}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitSql =
    filter.limit != null && filter.limit > 0 ? ` LIMIT ${Math.min(filter.limit, 500)}` : "";
  const r = await pgQuery(
    `SELECT cd.*, v.placa AS veiculo_placa_ref, v.cliente_vinculado_id
     FROM lanza.cliente_despesas cd
     LEFT JOIN lanza.veiculos v ON v.id = cd.veiculo_id
     ${whereSql}
     ORDER BY cd.data_autuacao${limitSql}`,
    params,
    "queryClienteDespesasFromSql",
  );
  return r.rows.map((row) => mapClienteDespesaRow(row as Record<string, unknown>));
}

export type QueryClienteDespesaByReferenciaOpts = {
  /** Inclui registros legados com ativo=false (soft delete antigo). */
  includeInativas?: boolean;
};

/** Busca despesa por auto_infracao ou id (Postgres). */
export async function queryClienteDespesaByReferenciaFromSql(
  referencia: string,
  opts?: QueryClienteDespesaByReferenciaOpts,
): Promise<Record<string, unknown> | null> {
  const key = referencia.trim();
  if (!key) return null;
  const byId = isUuid(key);
  const r = await pgQuery(
    byId
      ? `SELECT cd.*, v.placa AS veiculo_placa_ref, v.cliente_vinculado_id
         FROM lanza.cliente_despesas cd
         LEFT JOIN lanza.veiculos v ON v.id = cd.veiculo_id
         WHERE cd.id::text = $1
         LIMIT 1`
      : `SELECT cd.*, v.placa AS veiculo_placa_ref, v.cliente_vinculado_id
         FROM lanza.cliente_despesas cd
         LEFT JOIN lanza.veiculos v ON v.id = cd.veiculo_id
         WHERE lower(trim(cd.auto_infracao)) = lower(trim($1))
         LIMIT 1`,
    [key],
    byId ? "queryClienteDespesaByReferenciaFromSql/byId" : "queryClienteDespesaByReferenciaFromSql/byAuto",
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!opts?.includeInativas && row.ativo === false) return null;
  return mapClienteDespesaRow(row as Record<string, unknown>);
}

/** Remove uma despesa cliente do Postgres. */
export async function deleteClienteDespesaFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.cliente_despesas WHERE id = $1`, [id.trim()]);
  return (r.rowCount ?? 0) > 0;
}

export async function loadClienteDespesasFromSql(): Promise<ClienteDespesasDbShape> {
  return {
    descricao: "Débitos cobráveis do locatário.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    clienteDespesas: await queryClienteDespesasFromSql(),
  };
}

export type PersistClienteDespesaSqlOpts = {
  /** Evita SELECT em `lanza.veiculos` quando o UUID já está no registro ou no contexto. */
  veiculoId?: string | null;
  /** Não consulta `lanza.infracoes` (ex.: baixa de locação semanal). */
  skipInfracaoLookup?: boolean;
};

type ClienteDespesaPersistMeta = {
  id: string;
  veiculoIdResolved: string;
  infracaoId: string | null;
};

async function resolveClienteDespesaPersistMeta(
  d: Record<string, unknown>,
  opts?: PersistClienteDespesaSqlOpts,
): Promise<ClienteDespesaPersistMeta | null> {
  const id = asText(d.id);
  if (!id) return null;

  const veiculoRef = asText(d.veiculoId) ?? "";
  let veiculoIdResolved: string | null = opts?.veiculoId ?? null;
  if (!veiculoIdResolved) {
    veiculoIdResolved = isUuid(veiculoRef) ? veiculoRef : null;
    if (!veiculoIdResolved && veiculoRef.trim()) {
      veiculoIdResolved = await resolveVeiculoIdFromSql({ placa: veiculoRef });
    }
  }
  if (!veiculoIdResolved || !isUuid(veiculoIdResolved)) {
    throw new Error(
      `Despesa ${id}: veiculoId UUID obrigatório (ref informada: ${veiculoRef || "vazio"}).`,
    );
  }
  const auto = asText(d.autoInfracao) ?? id;

  let infracaoId: string | null = null;
  if (!opts?.skipInfracaoLookup) {
    const inf = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.infracoes WHERE lower(numero_auto) = lower($1) LIMIT 1",
      [auto],
      "upsertClienteDespesaRow/infracao",
    );
    infracaoId = inf.rows[0]?.id ?? null;
  }

  return { id, veiculoIdResolved, infracaoId };
}

function clienteDespesaRowSqlParams(
  d: Record<string, unknown>,
  meta: ClienteDespesaPersistMeta,
): unknown[] {
  const { id, veiculoIdResolved, infracaoId } = meta;
  const auto = asText(d.autoInfracao) ?? id;
  return [
    id,
    asText(d.categoria),
    veiculoIdResolved,
    auto,
    asText(d.titulo),
    asText(d.descricao) ?? "",
    asText(d.numeroAuto) ?? auto,
    asText(d.localInfracao),
    asText(d.dataAutuacao) ?? "",
    asNumber(d.valorMulta, 0),
    asText(d.situacao),
    asText(d.limiteDefesa),
    asText(d.dataLimiteDefesa),
    asText(d.dataVencimentoOriginal),
    asBool(d.convertidaEmDebito, false),
    isUuid(asText(d.condutorId)) ? d.condutorId : null,
    asBool(d.condutorConfirmado, false),
    asText(d.condutorContrato),
    asBool(d.condutorNaoIdentificado, false),
    asBool(d.debitoParceiroConfirmado, false),
    isUuid(asText(d.debitoParceiroId)) ? d.debitoParceiroId : null,
    asBool(d.revisarManual, false),
    asText(d.revisarMotivo),
    asBool(d.paga, false) || asText(d.statusCobranca) === "pago",
    parseIsoOrDataBr(asText(d.pagaEm)),
    (() => {
      const s = asText(d.statusCobranca);
      if (s === "pago" || s === "baixado" || s === "em_aberto") return s;
      return asBool(d.paga, false) ? "pago" : "em_aberto";
    })(),
    asBool(d.quitadaDetran, false),
    asText(d.statusInfracao),
    asText(d.statusDetran),
    d.rastreameId != null ? String(d.rastreameId) : null,
    d.rastreameMotoristaKey != null ? String(d.rastreameMotoristaKey) : null,
    d.rastreameRastreavelKey != null ? String(d.rastreameRastreavelKey) : null,
    parseIso(asText(d.rastreameDataIso)),
    asText(d.rastreameTipo),
    parseIso(asText(d.rastreameSyncEm)),
    asText(d.detranAutoInfracao),
    asText(d.pdfArquivo),
    infracaoId,
    asBool(d.ativo, true),
    asText(d.origem),
    parseIso(asText(d.cadastradoEm)),
  ];
}

const CLIENTE_DESPESA_UPSERT_SQL = `
    INSERT INTO lanza.cliente_despesas (
      id, categoria, veiculo_id, auto_infracao, titulo, descricao, numero_auto,
      local_infracao, data_autuacao, valor_multa, situacao, limite_defesa, data_limite_defesa,
      data_vencimento_original, convertida_em_debito, condutor_id, condutor_confirmado,
      condutor_contrato, condutor_nao_identificado, debito_parceiro_confirmado, debito_parceiro_id,
      revisar_manual, revisar_motivo, paga, paga_em, status_cobranca, quitada_detran, status_infracao, status_detran,
      rastreame_id, rastreame_motorista_key, rastreame_rastreavel_key, rastreame_data_iso,
      rastreame_tipo, rastreame_sync_em, detran_auto_infracao, pdf_arquivo, infracao_id, ativo,
      origem, cadastrado_em, atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
      $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,COALESCE($41::timestamptz, now()), now())
    ON CONFLICT (id) DO UPDATE SET
      categoria = EXCLUDED.categoria,
      veiculo_id = EXCLUDED.veiculo_id,
      auto_infracao = EXCLUDED.auto_infracao,
      titulo = EXCLUDED.titulo,
      descricao = EXCLUDED.descricao,
      numero_auto = EXCLUDED.numero_auto,
      local_infracao = EXCLUDED.local_infracao,
      data_autuacao = EXCLUDED.data_autuacao,
      valor_multa = EXCLUDED.valor_multa,
      situacao = EXCLUDED.situacao,
      limite_defesa = EXCLUDED.limite_defesa,
      condutor_id = EXCLUDED.condutor_id,
      condutor_confirmado = EXCLUDED.condutor_confirmado,
      condutor_contrato = EXCLUDED.condutor_contrato,
      condutor_nao_identificado = EXCLUDED.condutor_nao_identificado,
      revisar_manual = EXCLUDED.revisar_manual,
      paga = EXCLUDED.paga,
      paga_em = EXCLUDED.paga_em,
      status_cobranca = EXCLUDED.status_cobranca,
      quitada_detran = EXCLUDED.quitada_detran,
      rastreame_id = EXCLUDED.rastreame_id,
      rastreame_motorista_key = EXCLUDED.rastreame_motorista_key,
      rastreame_rastreavel_key = EXCLUDED.rastreame_rastreavel_key,
      rastreame_data_iso = EXCLUDED.rastreame_data_iso,
      rastreame_tipo = EXCLUDED.rastreame_tipo,
      infracao_id = COALESCE(EXCLUDED.infracao_id, lanza.cliente_despesas.infracao_id),
      ativo = EXCLUDED.ativo,
      origem = EXCLUDED.origem,
      atualizado_em = now()`;

/** Parâmetros do UPDATE (sem cadastrado_em); opcionalmente sem infracao_id. */
function clienteDespesaRowUpdateSqlParams(
  d: Record<string, unknown>,
  meta: ClienteDespesaPersistMeta,
  opts?: PersistClienteDespesaSqlOpts,
): unknown[] {
  const params = clienteDespesaRowSqlParams(d, meta).slice(0, 40);
  if (!opts?.skipInfracaoLookup) return params;
  return [...params.slice(0, 37), ...params.slice(38)];
}

/** UPDATE de uma linha existente (sem INSERT / ON CONFLICT). */
export async function updateClienteDespesaRowToSql(
  d: Record<string, unknown>,
  opts?: PersistClienteDespesaSqlOpts,
): Promise<void> {
  const meta = await resolveClienteDespesaPersistMeta(d, opts);
  if (!meta) return;

  const skipInfracao = opts?.skipInfracaoLookup === true;
  const infracaoSet = skipInfracao ? "" : "infracao_id = $38,";
  const ativoParam = skipInfracao ? "$38" : "$39";
  const origemParam = skipInfracao ? "$39" : "$40";

  await pgQuery(
    `UPDATE lanza.cliente_despesas SET
      categoria = $2,
      veiculo_id = $3,
      auto_infracao = $4,
      titulo = $5,
      descricao = $6,
      numero_auto = $7,
      local_infracao = $8,
      data_autuacao = $9,
      valor_multa = $10,
      situacao = $11,
      limite_defesa = $12,
      data_limite_defesa = $13,
      data_vencimento_original = $14,
      convertida_em_debito = $15,
      condutor_id = $16,
      condutor_confirmado = $17,
      condutor_contrato = $18,
      condutor_nao_identificado = $19,
      debito_parceiro_confirmado = $20,
      debito_parceiro_id = $21,
      revisar_manual = $22,
      revisar_motivo = $23,
      paga = $24,
      paga_em = $25,
      status_cobranca = $26,
      quitada_detran = $27,
      status_infracao = $28,
      status_detran = $29,
      rastreame_id = $30,
      rastreame_motorista_key = $31,
      rastreame_rastreavel_key = $32,
      rastreame_data_iso = $33,
      rastreame_tipo = $34,
      rastreame_sync_em = $35,
      detran_auto_infracao = $36,
      pdf_arquivo = $37,
      ${infracaoSet}
      ativo = ${ativoParam},
      origem = ${origemParam},
      atualizado_em = now()
    WHERE id = $1`,
    clienteDespesaRowUpdateSqlParams(d, meta, opts),
    "updateClienteDespesaRow",
  );
}

/** INSERT de uma nova linha (sem UPDATE / ON CONFLICT). */
export async function insertClienteDespesaRowToSql(
  d: Record<string, unknown>,
  opts?: PersistClienteDespesaSqlOpts,
): Promise<void> {
  const meta = await resolveClienteDespesaPersistMeta(d, opts);
  if (!meta) return;

  await pgQuery(
    `INSERT INTO lanza.cliente_despesas (
      id, categoria, veiculo_id, auto_infracao, titulo, descricao, numero_auto,
      local_infracao, data_autuacao, valor_multa, situacao, limite_defesa, data_limite_defesa,
      data_vencimento_original, convertida_em_debito, condutor_id, condutor_confirmado,
      condutor_contrato, condutor_nao_identificado, debito_parceiro_confirmado, debito_parceiro_id,
      revisar_manual, revisar_motivo, paga, paga_em, status_cobranca, quitada_detran, status_infracao, status_detran,
      rastreame_id, rastreame_motorista_key, rastreame_rastreavel_key, rastreame_data_iso,
      rastreame_tipo, rastreame_sync_em, detran_auto_infracao, pdf_arquivo, infracao_id, ativo,
      origem, cadastrado_em, atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
      $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,COALESCE($41::timestamptz, now()), now())`,
    clienteDespesaRowSqlParams(d, meta),
    "insertClienteDespesaRow",
  );
}

export async function upsertClienteDespesaRowToSql(
  d: Record<string, unknown>,
  opts?: PersistClienteDespesaSqlOpts,
): Promise<void> {
  const meta = await resolveClienteDespesaPersistMeta(
    { ...d, id: asText(d.id) ?? randomUUID() },
    opts,
  );
  if (!meta) return;

  await pgQuery(
    CLIENTE_DESPESA_UPSERT_SQL,
    clienteDespesaRowSqlParams(d, meta),
    "upsertClienteDespesaRow",
  );
}

export async function saveClienteDespesasToSql(db: ClienteDespesasDbShape): Promise<void> {
  for (const d of db.clienteDespesas) {
    await upsertClienteDespesaRowToSql(d);
  }
}

// --- Parceiro despesas ---

export type ParceiroDespesasDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaParceiroDespesa?: Record<string, string>;
  parceiroDespesas: Record<string, unknown>[];
};

function mapParceiroDespesaRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    veiculoId: row.veiculo_id,
    placa: row.placa,
    categoria: row.categoria,
    descricao: row.descricao,
    data: row.data,
    valor: Number(row.valor),
    competencia: row.competencia,
    origem: row.origem,
    rastreameManutencaoId: row.rastreame_manutencao_id,
    rastreameSyncEm: rowIso(row.rastreame_sync_em),
    rastreameHash: row.rastreame_hash,
    baixa: row.baixa,
  };
}

export type ParceiroDespesasSqlFilter = {
  /** UUID do veículo (placa deve ser resolvida na camada de listagem). */
  veiculoId?: string;
  parceiroId?: string;
  categoria?: string;
  competencia?: string;
  emAberto?: boolean;
  veiculoAtivo?: boolean;
};

/** Listagem filtrada no Postgres (período BR continua no app). */
export async function queryParceiroDespesasFromSql(
  filter: ParceiroDespesasSqlFilter = {},
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  if (filter.emAberto === true) {
    where.push(`(pd.baixa IS NULL OR trim(pd.baixa) = '')`);
  } else if (filter.emAberto === false) {
    where.push(`(pd.baixa IS NOT NULL AND trim(pd.baixa) <> '')`);
  }

  if (filter.categoria?.trim()) {
    params.push(filter.categoria.trim());
    where.push(`lower(trim(pd.categoria)) = lower(trim($${p++}))`);
  }

  if (filter.competencia?.trim()) {
    params.push(filter.competencia.trim());
    where.push(`pd.competencia = $${p++}`);
  }

  if (filter.parceiroId?.trim() && isUuid(filter.parceiroId.trim())) {
    params.push(filter.parceiroId.trim());
    where.push(`EXISTS (
      SELECT 1
      FROM lanza.parceiro_veiculo_vinculos pv
      WHERE pv.parceiro_id::text = $${p}
        AND pv.veiculo_id = pd.veiculo_id
    )`);
    p += 1;
  }

  if (filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim())) {
    params.push(filter.veiculoId.trim());
    where.push(`pd.veiculo_id::text = $${p++}`);
  }

  if (filter.veiculoAtivo === true) {
    where.push(`(v.id IS NOT NULL AND v.ativo IS DISTINCT FROM false)`);
  } else if (filter.veiculoAtivo === false) {
    where.push(`(v.id IS NOT NULL AND v.ativo = false)`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await pgQuery(
    `SELECT pd.*, v.placa AS veiculo_placa_ref, v.ativo AS veiculo_ativo
     FROM lanza.parceiro_despesas pd
     LEFT JOIN lanza.veiculos v ON v.id = pd.veiculo_id
     ${whereSql}
     ORDER BY pd.data`,
    params,
  );
  return r.rows.map((row) => mapParceiroDespesaRow(row as Record<string, unknown>));
}

export async function loadParceiroDespesasFromSql(): Promise<ParceiroDespesasDbShape> {
  return {
    descricao: "Despesas do parceiro/proprietário.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    parceiroDespesas: await queryParceiroDespesasFromSql(),
  };
}

async function upsertParceiroDespesaRowToSql(
  d: Record<string, unknown>,
  placaMap: Map<string, string>,
): Promise<void> {
  const id = asText(d.id) ?? randomUUID();
  const placa = formatPlacaHyphen(asText(d.placa) ?? asText(d.veiculoId) ?? "");
  await pgQuery(
    `INSERT INTO lanza.parceiro_despesas (
      id, veiculo_id, placa, categoria, descricao, data, valor, competencia, origem,
      rastreame_manutencao_id, rastreame_sync_em, rastreame_hash, baixa, atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
    ON CONFLICT (id) DO UPDATE SET
      veiculo_id = EXCLUDED.veiculo_id,
      placa = EXCLUDED.placa,
      categoria = EXCLUDED.categoria,
      descricao = EXCLUDED.descricao,
      data = EXCLUDED.data,
      valor = EXCLUDED.valor,
      competencia = EXCLUDED.competencia,
      origem = EXCLUDED.origem,
      rastreame_manutencao_id = EXCLUDED.rastreame_manutencao_id,
      rastreame_sync_em = EXCLUDED.rastreame_sync_em,
      rastreame_hash = EXCLUDED.rastreame_hash,
      baixa = EXCLUDED.baixa,
      atualizado_em = now()`,
    [
      id,
      resolveVeiculoId(asText(d.veiculoId) ?? placa, placaMap),
      placa,
      asText(d.categoria) ?? "Outros",
      asText(d.descricao) ?? "",
      asText(d.data) ?? "",
      asNumber(d.valor, 0),
      asText(d.competencia) ?? "",
      asText(d.origem),
      d.rastreameManutencaoId != null ? String(d.rastreameManutencaoId) : null,
      parseIso(asText(d.rastreameSyncEm)),
      asText(d.rastreameHash),
      asText(d.baixa),
    ],
  );
}

/** Grava ou atualiza uma única despesa de parceiro no Postgres. */
export async function upsertParceiroDespesaToSql(d: Record<string, unknown>): Promise<void> {
  const placaMap = await loadPlacaMap();
  await upsertParceiroDespesaRowToSql(d, placaMap);
}

/** Remove uma despesa de parceiro do Postgres. */
export async function deleteParceiroDespesaFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.parceiro_despesas WHERE id = $1`, [id.trim()]);
  return (r.rowCount ?? 0) > 0;
}

/** Remove espelhos parceiro pelo campo origem (ex.: pedágio sem locatário). */
export async function deleteParceiroDespesaByOrigemFromSql(origem: string): Promise<boolean> {
  const key = origem.trim();
  if (!key) return false;
  const r = await pgWriteQuery(`DELETE FROM lanza.parceiro_despesas WHERE origem = $1`, [key]);
  return (r.rowCount ?? 0) > 0;
}

export async function saveParceiroDespesasToSql(db: ParceiroDespesasDbShape): Promise<void> {
  const placaMap = await loadPlacaMap();
  for (const d of db.parceiroDespesas) {
    await upsertParceiroDespesaRowToSql(d, placaMap);
  }
}

// --- Triagens / análise (schema v2: lanza.cliente_analise_cadastro) ---

const FONTE_NOMES: Record<string, string> = {
  bnmp: "CNJ BNMP",
  "pf-sinic": "PF SINIC",
  tjsc: "TJSC Certidões",
};

function mapAnaliseCadastroStatus(alerta: boolean, status: string | null): string {
  if (alerta) return "reprovado";
  if (status && ["assistido", "pendente", "erro", "pulado"].includes(status)) return "inconclusivo";
  return "aprovado";
}

function unmapAnaliseCadastroStatus(dbStatus: string): { alerta: boolean; status: string } {
  if (dbStatus === "reprovado") return { alerta: true, status: "ok" };
  if (dbStatus === "inconclusivo") return { alerta: false, status: "pendente" };
  return { alerta: false, status: "ok" };
}

function triagemAprovadoFromStatus(
  triagemRow: Record<string, unknown> | undefined,
  fontes: Record<string, unknown>[],
): boolean | null {
  if (triagemRow?.status === "reprovado") return false;
  if (triagemRow?.status === "aprovado") return true;
  if (triagemRow?.status === "inconclusivo") return null;
  if (fontes.some((f) => f.alerta === true)) return false;
  if (fontes.length > 0 && fontes.every((f) => f.status === "ok" && f.alerta !== true)) return true;
  return null;
}

export type TriagemDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schemaTriagem?: Record<string, string>;
  triagens: Record<string, unknown>[];
};

export async function loadTriagensFromSql(): Promise<TriagemDbShape> {
  const base = await pgQuery(`
    SELECT c.*, cl.nome AS cliente_nome, cl.cpf AS cliente_cpf_fmt, cl.data_nascimento AS cliente_nascimento
    FROM lanza.cliente_analise_cadastro c
    LEFT JOIN lanza.clientes cl ON cl.id = c.cliente_id
    ORDER BY c.data_consulta DESC, c.cpf
  `);

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of base.rows) {
    const dataConsulta = String(row.data_consulta).slice(0, 10);
    const key = `${row.cpf}|${dataConsulta}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const triagens: Record<string, unknown>[] = [];
  for (const rows of groups.values()) {
    const triagemRow = rows.find((r) => r.origem === "triagem");
    const fonteRows = rows.filter((r) => r.origem !== "triagem");
    const anchor = triagemRow ?? rows[0]!;

    const fontes = fonteRows.map((f) => {
      const { alerta, status } = unmapAnaliseCadastroStatus(String(f.status));
      const achados = f.achados as unknown[] | null;
      return {
        id: String(f.origem),
        nome: FONTE_NOMES[String(f.origem)] ?? String(f.origem),
        status,
        alerta,
        observacao: String(f.descricao ?? ""),
        qtdAchados: Array.isArray(achados) ? achados.length : 0,
        evidencia: f.evidencia as string | null,
        consultadoEm: rowIso(f.consultado_em) ?? new Date().toISOString(),
      };
    });

    const alertaGeral =
      fontes.some((f) => f.alerta) || String(anchor.status) === "reprovado";
    const lgpd = anchor.base_legal
      ? { baseLegal: String(anchor.base_legal), titularConsentimento: null, solicitante: null, finalidade: null }
      : undefined;

    triagens.push({
      id: String(anchor.id),
      clienteId: anchor.cliente_id,
      cpf: anchor.cpf,
      cpfFormatado: anchor.cliente_cpf_fmt,
      nome: anchor.cliente_nome ?? "?",
      nascimento: anchor.cliente_nascimento ?? "",
      dataConsulta: String(anchor.data_consulta).slice(0, 10),
      alertaGeral,
      aprovado: triagemAprovadoFromStatus(triagemRow, fontes),
      resumo: triagemRow ? String(triagemRow.descricao ?? "") : fontes.map((f) => f.observacao).join("; "),
      relatorioJson: null,
      relatorioTxt: null,
      cadastradoEm: rowIso(anchor.cadastrado_em),
      atualizadoEm: rowIso(anchor.atualizado_em),
      lgpd,
      fontes,
    });
  }

  return {
    descricao: "Histórico de análises de cadastro.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    triagens,
  };
}

export async function upsertTriagemToSql(t: Record<string, unknown>): Promise<void> {
  const triagemId = asText(t.id) ?? randomUUID();
  const cpf = normCpf(asText(t.cpf)) ?? asText(t.cpf) ?? "";
  const dataConsulta = asText(t.dataConsulta) ?? "";
  const clienteId = isUuid(asText(t.clienteId)) ? t.clienteId : null;
  const lgpd = t.lgpd as Record<string, unknown> | undefined;
  const baseLegal = lgpd ? asText(lgpd.baseLegal) : null;

  if (t.aprovado === true || t.aprovado === false) {
    if (clienteId) {
      await pgQuery(
        `UPDATE lanza.clientes SET analise_aprovado = $2, analise_avaliado_em = now(), atualizado_em = now()
         WHERE id = $1::uuid`,
        [clienteId, t.aprovado],
      );
    } else if (cpf) {
      await pgQuery(
        `UPDATE lanza.clientes SET analise_aprovado = $2, analise_avaliado_em = now(), atualizado_em = now()
         WHERE cpf_norm = $1 OR cpf = $1`,
        [cpf, t.aprovado],
      );
    }
  }

  const fontes = t.fontes as Record<string, unknown>[] | undefined;
  if (Array.isArray(fontes)) {
    for (const f of fontes) {
      const origem = asText(f.id) ?? asText(f.nome) ?? "fonte";
      const status = mapAnaliseCadastroStatus(asBool(f.alerta, false), asText(f.status));
      await pgQuery(
        `INSERT INTO lanza.cliente_analise_cadastro (
          id, cliente_id, cpf, data_consulta, consultado_em, origem, descricao, status,
          evidencia, base_legal, cadastrado_em, atualizado_em
        ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::lanza.analise_cadastro_status,$9,$10,
          COALESCE($11::timestamptz, now()), COALESCE($12::timestamptz, now()))
        ON CONFLICT (cpf, origem, data_consulta) DO UPDATE SET
          status = EXCLUDED.status, descricao = EXCLUDED.descricao, evidencia = EXCLUDED.evidencia,
          base_legal = COALESCE(EXCLUDED.base_legal, lanza.cliente_analise_cadastro.base_legal),
          consultado_em = EXCLUDED.consultado_em, atualizado_em = now()`,
        [
          randomUUID(),
          clienteId,
          cpf,
          dataConsulta,
          parseIso(asText(f.consultadoEm)),
          origem,
          asText(f.observacao) ?? "",
          status,
          asText(f.evidencia),
          baseLegal,
          parseIso(asText(t.cadastradoEm)),
          parseIso(asText(t.atualizadoEm)),
        ],
      );
    }
  }

  if (dataConsulta) {
    const triagemStatus =
      t.aprovado === false
        ? "reprovado"
        : t.aprovado === true
          ? "aprovado"
          : mapAnaliseCadastroStatus(asBool(t.alertaGeral, false), null);
    await pgQuery(
      `INSERT INTO lanza.cliente_analise_cadastro (
        id, cliente_id, cpf, data_consulta, origem, descricao, status, base_legal,
        cadastrado_em, atualizado_em
      ) VALUES ($1,$2,$3,$4::date,'triagem',$5,$6::lanza.analise_cadastro_status,$7,
        COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, now()))
      ON CONFLICT (cpf, origem, data_consulta) DO UPDATE SET
        status = EXCLUDED.status, descricao = EXCLUDED.descricao, base_legal = COALESCE(EXCLUDED.base_legal, lanza.cliente_analise_cadastro.base_legal),
        atualizado_em = now()`,
      [
        triagemId,
        clienteId,
        cpf,
        dataConsulta,
        asText(t.resumo) ?? "",
        triagemStatus,
        baseLegal,
        parseIso(asText(t.cadastradoEm)),
        parseIso(asText(t.atualizadoEm)),
      ],
    );
  }
}

export async function saveTriagensToSql(db: TriagemDbShape): Promise<void> {
  for (const t of db.triagens) {
    await upsertTriagemToSql(t);
  }
}

// --- Cliente análise ---

export type ClienteAnaliseDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  schema?: Record<string, string>;
  registros: Record<string, unknown>[];
};

export async function loadClienteAnaliseFromSql(): Promise<ClienteAnaliseDbShape> {
  const base = await pgQuery(`
    SELECT c.*, cl.nome AS cliente_nome, cl.cpf AS cliente_cpf_fmt
    FROM lanza.cliente_analise_cadastro c
    LEFT JOIN lanza.clientes cl ON cl.id = c.cliente_id
    WHERE c.origem <> 'triagem'
    ORDER BY c.data_consulta DESC
  `);
  const registros: Record<string, unknown>[] = [];

  for (const row of base.rows) {
    const { alerta, status } = unmapAnaliseCadastroStatus(String(row.status));
    const achadosRaw = row.achados as Record<string, unknown>[] | null;
    const achados = Array.isArray(achadosRaw)
      ? achadosRaw.map((a) => ({
          tipo: asText(a.tipo) ?? "outro",
          descricao: asText(a.descricao) ?? "",
        }))
      : [];
    const origem = String(row.origem);
    registros.push({
      id: String(row.id),
      clienteId: row.cliente_id,
      cpf: row.cpf,
      cpfFormatado: row.cliente_cpf_fmt,
      nome: row.cliente_nome ?? "?",
      fonte: origem,
      fonteNome: FONTE_NOMES[origem] ?? origem,
      site: (row.site_raw as Record<string, unknown> | null)?.site ?? null,
      status,
      alerta,
      identificado: row.descricao,
      achados,
      evidencia: row.evidencia,
      dataConsulta: String(row.data_consulta).slice(0, 10),
      consultadoEm: rowIso(row.consultado_em) ?? null,
      analiseId: null,
      cadastradoEm: rowIso(row.cadastrado_em),
      atualizadoEm: rowIso(row.atualizado_em),
    });
  }

  return {
    descricao: "Achados da análise de cadastro por cliente.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    registros,
  };
}

export async function upsertClienteAnaliseRowToSql(r: Record<string, unknown>): Promise<void> {
  const id = asText(r.id) ?? randomUUID();
  const cpf = normCpf(asText(r.cpf)) ?? asText(r.cpf) ?? "";
  const origem = asText(r.fonte) ?? asText(r.site) ?? "?";
  const achados = r.achados as Record<string, unknown>[] | undefined;
  const achadosJson =
    Array.isArray(achados) && achados.length
      ? achados.map((a) => ({ tipo: asText(a.tipo) ?? "outro", descricao: asText(a.descricao) ?? "" }))
      : null;

  await pgQuery(
    `INSERT INTO lanza.cliente_analise_cadastro (
      id, cliente_id, cpf, data_consulta, consultado_em, origem, descricao, status,
      evidencia, achados, cadastrado_em, atualizado_em
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::lanza.analise_cadastro_status,$9,$10,
      COALESCE($11::timestamptz, now()), COALESCE($12::timestamptz, now()))
    ON CONFLICT (cpf, origem, data_consulta) DO UPDATE SET
      descricao = EXCLUDED.descricao, status = EXCLUDED.status, evidencia = EXCLUDED.evidencia,
      achados = EXCLUDED.achados, consultado_em = EXCLUDED.consultado_em, atualizado_em = now()`,
    [
      id,
      isUuid(asText(r.clienteId)) ? r.clienteId : null,
      cpf,
      asText(r.dataConsulta) ?? "",
      parseIso(asText(r.consultadoEm)),
      origem,
      asText(r.identificado) ?? "",
      mapAnaliseCadastroStatus(asBool(r.alerta, false), asText(r.status)),
      asText(r.evidencia),
      achadosJson,
      parseIso(asText(r.cadastradoEm)),
      parseIso(asText(r.atualizadoEm)),
    ],
  );
}

export async function saveClienteAnaliseToSql(db: ClienteAnaliseDbShape): Promise<void> {
  for (const r of db.registros) {
    await upsertClienteAnaliseRowToSql(r);
  }
}
