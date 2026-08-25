import {
  ensureVercelPgPool,
  getPgPool,
  getVercelPostgresPool,
  getVercelPoolInitError,
  pgQuery,
} from "../client/PostgresPool.js";
import { pgWriteQuery } from "../client/pgWrite.js";
import {
  crlvFieldsToJson,
  pickCnhFields,
  pickCrlvFromVeiculo,
  upsertClienteCnh,
  upsertVeiculoCrlv,
} from "../migration/documentFields.js";
import { compactPlaca, formatPlacaHyphen, isUuid, normCpf } from "../migration/relationalUtils.js";

export type ParceiroRow = { id: string; nome: string; ativo?: boolean };
export type VinculoRow = { id: string; veiculoId: string; parceiroId: string };

export type ParceirosDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  parceiros: ParceiroRow[];
};

export type VinculosDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  vinculos: VinculoRow[];
};

const DEFAULT_PARCEIROS_DESC =
  "Proprietários dos veículos da frota. id = uuid. Chave de negócio: nome (único na prática).";

export async function loadParceirosFromSql(): Promise<ParceirosDbShape> {
  const r = await pgQuery<{ id: string; nome: string; ativo: boolean }>(
    "SELECT id, nome, ativo FROM lanza.parceiros ORDER BY nome",
  );
  return {
    descricao: DEFAULT_PARCEIROS_DESC,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    parceiros: r.rows.map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo })),
  };
}

export async function loadVinculosFromSql(): Promise<VinculosDbShape> {
  const r = await pgQuery<{ id: string; veiculo_id: string; parceiro_id: string }>(
    "SELECT id, veiculo_id, parceiro_id FROM lanza.parceiro_veiculo_vinculos ORDER BY id",
  );
  return {
    descricao: "Vínculo veículo–parceiro.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    vinculos: r.rows.map((v) => ({
      id: v.id,
      veiculoId: v.veiculo_id,
      parceiroId: v.parceiro_id,
    })),
  };
}

export async function saveParceirosToSql(db: ParceirosDbShape): Promise<void> {
  for (const p of db.parceiros) {
    await upsertParceiroRowToSql(p);
  }
}

export async function upsertParceiroRowToSql(p: ParceiroRow): Promise<ParceiroRow> {
  ensureVercelPgPool();
  const pool =
    getVercelPostgresPool() ??
    (process.env.VERCEL ? null : await getPgPool());
  if (!pool) {
    const detail = getVercelPoolInitError();
    throw new Error(
      detail ??
        (process.env.VERCEL
          ? "Pool PostgreSQL indisponível na Vercel (AWS_ROLE_ARN / integração OIDC com RDS)"
          : "PostgreSQL não configurado"),
    );
  }

  const client = await pool.connect();
  let row: { id: string; nome: string; ativo: boolean };
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string; nome: string; ativo: boolean }>(
      `INSERT INTO lanza.parceiros (id, nome, ativo, atualizado_em) VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo, atualizado_em = now()
       RETURNING id, nome, ativo`,
      [p.id, p.nome, p.ativo !== false],
    );
    row = inserted.rows[0]!;
    if (!row) throw new Error("Falha ao gravar parceiro no PostgreSQL");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const check = await pool.query<{ id: string }>(`SELECT id FROM lanza.parceiros WHERE id = $1`, [row.id]);
  if (!check.rows[0]) {
    throw new Error("Parceiro gravado mas não visível após COMMIT");
  }

  return { id: row.id, nome: row.nome, ativo: row.ativo };
}

export async function deleteParceiroRowFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.parceiros WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function upsertVinculoToSql(v: {
  id: string;
  parceiroId: string;
  veiculoId: string;
}): Promise<void> {
  await pgWriteQuery(
    `INSERT INTO lanza.parceiro_veiculo_vinculos (id, parceiro_id, veiculo_id, atualizado_em)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO UPDATE SET parceiro_id = EXCLUDED.parceiro_id, veiculo_id = EXCLUDED.veiculo_id, atualizado_em = now()`,
    [v.id, v.parceiroId, v.veiculoId],
  );
}

export async function deleteVinculoFromSql(id: string): Promise<boolean> {
  const r = await pgWriteQuery(`DELETE FROM lanza.parceiro_veiculo_vinculos WHERE id = $1`, [id.trim()]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteVinculosByVeiculoFromSql(veiculoId: string): Promise<number> {
  const r = await pgWriteQuery(`DELETE FROM lanza.parceiro_veiculo_vinculos WHERE veiculo_id = $1`, [
    veiculoId.trim(),
  ]);
  return r.rowCount ?? 0;
}

export async function saveVinculosToSql(db: VinculosDbShape): Promise<void> {
  for (const v of db.vinculos) {
    await upsertVinculoToSql(v);
  }
}

export type VeiculoRow = Record<string, unknown> & {
  id: string;
  placa: string;
};

export type VeiculosDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  veiculos: VeiculoRow[];
};

const DEFAULT_VEICULOS_DESC =
  "Frota de locação de veículos da Nathalia. id = uuid. Chave natural: placa.";

function rowToVeiculo(r: Record<string, unknown>): VeiculoRow {
  const veiculo: VeiculoRow = {
    id: String(r.id),
    placa: String(r.placa),
    marcaModelo: r.marca_modelo ?? undefined,
    marca: r.marca ?? undefined,
    modelo: r.modelo ?? undefined,
    anoModelo: r.ano_modelo ?? undefined,
    ano: r.ano ?? undefined,
    chassi: r.chassi ?? undefined,
    renavam: r.renavam ?? undefined,
    cor: r.cor ?? undefined,
    combustivel: r.combustivel ?? undefined,
    categoria: r.categoria ?? undefined,
    tipo: r.tipo ?? undefined,
    licencaIma: r.licenca_ima ?? undefined,
    vencimentoDocumento: r.vencimento_documento ?? undefined,
    ufRegistro: r.uf_registro ?? undefined,
    fipe: undefined,
    fipeModelo: undefined,
    fipeCodigo: undefined,
    fipeValor: undefined,
    fipeReferencia: undefined,
    rastreameRastreavelKey: r.rastreame_rastreavel_key ?? undefined,
    rastreameLabel: r.rastreame_label ?? undefined,
    rastreameSyncEm: r.rastreame_sync_em ?? undefined,
    clienteVinculadoId: r.cliente_vinculado_id ?? undefined,
    inicioLocacoes: r.inicio_locacoes ?? undefined,
    ativo: r.ativo !== false,
    tipoFrota: (r.tipo_frota as string | undefined) ?? (r.particular === true ? "particular" : "locacao"),
    particular: r.particular === true,
    origem: r.origem ?? undefined,
    atualizadoEm: r.atualizado_em ?? undefined,
    valorSemanal: r.valor_semanal != null ? Number(r.valor_semanal) : undefined,
    valorMensal: r.valor_mensal != null ? Number(r.valor_mensal) : undefined,
    valorDiaria: r.valor_diaria != null ? Number(r.valor_diaria) : undefined,
    valorCaucao: r.valor_caucao != null ? Number(r.valor_caucao) : undefined,
  };

  const crlvJson = crlvFieldsToJson(r);
  if (Object.keys(crlvJson).length) {
    veiculo.crlv = crlvJson;
  }

  return veiculo;
}

export async function loadVeiculosFromSqlLight(): Promise<VeiculosDbShape> {
  const r = await pgQuery(
    `SELECT v.* FROM lanza.veiculos v ORDER BY v.placa`,
    undefined,
    "loadVeiculosFromSqlLight",
  );
  return {
    descricao: DEFAULT_VEICULOS_DESC,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    veiculos: r.rows.map((row) => rowToVeiculo(row as Record<string, unknown>)),
  };
}

export async function loadVeiculosFromSql(): Promise<VeiculosDbShape> {
  const r = await pgQuery(
    `SELECT v.*,
      f.code_fipe AS fipe_codigo, f.modelo AS fipe_modelo, f.valor_texto AS fipe_valor,
      f.referencia_mes AS fipe_referencia, f.fipe_url
     FROM lanza.veiculos v
     LEFT JOIN LATERAL (
       SELECT * FROM lanza.veiculo_fipe vf
       WHERE vf.veiculo_id = v.id AND vf.ativo = true
       ORDER BY vf.referencia_mes DESC NULLS LAST, vf.atualizado_em DESC
       LIMIT 1
     ) f ON true
     ORDER BY v.placa`,
  );
  return {
    descricao: DEFAULT_VEICULOS_DESC,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    veiculos: r.rows.map((row) => {
      const mapped = { ...(row as Record<string, unknown>) };
      if (mapped.fipe_url != null) mapped.fipe_url = mapped.fipe_url;
      if (mapped.crlv_observacoes != null) {
        mapped.observacoes = mapped.crlv_observacoes;
      }
      const veiculo = rowToVeiculo(mapped);
      if (mapped.fipe_url) veiculo.fipe = mapped.fipe_url;
      if (mapped.fipe_modelo) veiculo.fipeModelo = mapped.fipe_modelo;
      if (mapped.fipe_codigo) veiculo.fipeCodigo = mapped.fipe_codigo;
      if (mapped.fipe_valor) veiculo.fipeValor = mapped.fipe_valor;
      if (mapped.fipe_referencia) veiculo.fipeReferencia = mapped.fipe_referencia;
      return veiculo;
    }),
  };
}

export async function saveVeiculosToSql(db: VeiculosDbShape): Promise<void> {
  for (const v of db.veiculos) {
    await upsertVeiculoToSql(v as Record<string, unknown>);
  }
}

/** Grava ou atualiza um único veículo no Postgres (sem reescrever toda a tabela). */
function tipoFrotaFromVeiculoRecord(v: Record<string, unknown>): string {
  const tf = String(v.tipoFrota ?? "").trim().toLowerCase();
  if (tf === "locacao" || tf === "particular" || tf === "venda") return tf;
  return v.particular === true ? "particular" : "locacao";
}

export async function upsertVeiculoToSql(v: Record<string, unknown>): Promise<void> {
  const placa = formatPlacaHyphen(String(v.placa));
  const tipoFrota = tipoFrotaFromVeiculoRecord(v);
  const particular = tipoFrota === "particular";
  await pgWriteQuery(
    `INSERT INTO lanza.veiculos (
        id, placa, placa_norm, marca_modelo, marca, modelo, ano_modelo, ano, chassi, renavam, cor,
        combustivel, categoria, tipo, licenca_ima, vencimento_documento, uf_registro,
        rastreame_rastreavel_key, rastreame_label, rastreame_sync_em,
        cliente_vinculado_id, inicio_locacoes, ativo, particular, tipo_frota, origem,
        valor_semanal, valor_mensal, valor_diaria, valor_caucao, atualizado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,now())
      ON CONFLICT (id) DO UPDATE SET
        placa = EXCLUDED.placa, placa_norm = EXCLUDED.placa_norm, ativo = EXCLUDED.ativo,
        particular = EXCLUDED.particular, tipo_frota = EXCLUDED.tipo_frota,
        cliente_vinculado_id = EXCLUDED.cliente_vinculado_id, rastreame_label = EXCLUDED.rastreame_label,
        valor_semanal = EXCLUDED.valor_semanal, valor_mensal = EXCLUDED.valor_mensal,
        valor_diaria = EXCLUDED.valor_diaria, valor_caucao = EXCLUDED.valor_caucao, atualizado_em = now()`,
    [
      v.id,
      placa,
      compactPlaca(placa),
      v.marcaModelo ?? null,
      v.marca ?? null,
      v.modelo ?? null,
      v.anoModelo ?? null,
      typeof v.ano === "number" ? v.ano : null,
      v.chassi ?? null,
      v.renavam ?? null,
      v.cor ?? null,
      v.combustivel ?? null,
      v.categoria ?? null,
      v.tipo ?? null,
      v.licencaIma ?? null,
      v.vencimentoDocumento ?? null,
      v.ufRegistro ?? null,
      v.rastreameRastreavelKey != null ? String(v.rastreameRastreavelKey) : null,
      v.rastreameLabel ?? null,
      v.rastreameSyncEm ?? null,
      v.clienteVinculadoId ?? null,
      v.inicioLocacoes ?? null,
      v.ativo !== false,
      particular,
      tipoFrota,
      v.origem ?? null,
      typeof v.valorSemanal === "number" ? v.valorSemanal : null,
      typeof v.valorMensal === "number" ? v.valorMensal : null,
      typeof v.valorDiaria === "number" ? v.valorDiaria : null,
      typeof v.valorCaucao === "number" ? v.valorCaucao : null,
    ],
  );

  const refMes = (v.fipeReferencia as string | undefined) ?? "importado";
  if (v.fipeCodigo || v.fipe || v.fipeModelo) {
    await pgWriteQuery(
      `INSERT INTO lanza.veiculo_fipe (
          id, veiculo_id, code_fipe, modelo, valor_texto, referencia_mes, fipe_url, origem, ativo, cadastrado_em, atualizado_em
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, true, now(), now())
        ON CONFLICT (veiculo_id, referencia_mes) DO UPDATE SET
          code_fipe = EXCLUDED.code_fipe, modelo = EXCLUDED.modelo, valor_texto = EXCLUDED.valor_texto,
          fipe_url = EXCLUDED.fipe_url, atualizado_em = now()`,
      [
        v.id,
        v.fipeCodigo ?? v.id,
        v.fipeModelo ?? null,
        v.fipeValor ?? null,
        refMes,
        v.fipe ?? null,
        v.origem ?? "sql-save",
      ],
    );
  }

  const crlv = pickCrlvFromVeiculo(v);
  if (crlv) {
    await upsertVeiculoCrlv((sql, params) => pgQuery(sql, params), String(v.id), crlv);
  }
}

export type ClienteRow = Record<string, unknown> & { id: string; nome: string };

export type ClientesDbShape = {
  descricao?: string;
  atualizadoEm?: string;
  clientes: ClienteRow[];
};

const DEFAULT_CLIENTES_DESC =
  "Clientes (motoristas/locatários) da frota. id = uuid. Chave natural: cpf.";

function buildClienteRowFromSql(
  row: Record<string, unknown>,
  endRow?: Record<string, unknown>,
): ClienteRow {
  const id = String(row.id);
  const cliente: ClienteRow = {
      id,
      nome: String(row.nome),
      cpf: row.cpf ?? undefined,
      rg: row.rg ?? undefined,
      rgOrgaoExpedidor: row.rg_orgao_expedidor ?? undefined,
      dataNascimento: row.data_nascimento ?? undefined,
      localNascimento: row.local_nascimento ?? undefined,
      filiacao: row.filiacao ?? undefined,
      telefone: row.telefone ?? undefined,
      email: row.email ?? undefined,
      cnhArquivo: row.cnh_arquivo ?? undefined,
      cnhStorageKey: row.cnh_storage_key ?? undefined,
      cnhDocumentoNome: row.cnh_documento_nome ?? undefined,
      comprovanteStorageKey: row.comprovante_storage_key ?? undefined,
      comprovanteDocumentoNome: row.comprovante_documento_nome ?? undefined,
      pastaContratoOrigem: row.pasta_contrato_origem ?? undefined,
      origemImportacao: row.origem_importacao ?? undefined,
      rastreameMotoristaKey: row.rastreame_motorista_key ?? undefined,
      rastreameMotoristaId: row.rastreame_motorista_id ?? undefined,
      rastreameSyncEm: row.rastreame_sync_em ?? undefined,
      ativo: row.ativo !== false,
      atualizadoEm: row.atualizado_em ?? undefined,
    };

    if (
      row.cnh_numero_registro ||
      row.cnh_categoria ||
      row.cnh_validade ||
      row.cnh_numero_espelho
    ) {
      cliente.cnh = {
        numeroRegistro: row.cnh_numero_registro,
        categoria: row.cnh_categoria,
        primeiraHabilitacao: row.cnh_primeira_habilitacao,
        dataEmissao: row.cnh_data_emissao,
        validade: row.cnh_validade,
        numeroEspelho: row.cnh_numero_espelho,
        orgaoEmissor: row.cnh_orgao_emissor,
        ufEmissor: row.cnh_uf_emissor,
        ear: row.cnh_ear,
        observacoes: row.cnh_observacoes,
      };
    }
    if (endRow) {
      cliente.endereco = {
        cep: endRow.cep,
        logradouro: endRow.logradouro,
        numero: endRow.numero,
        complemento: endRow.complemento,
        bairro: endRow.bairro,
        cidade: endRow.cidade,
        uf: endRow.uf,
      };
    }
    if (row.analise_aprovado === true || row.analise_aprovado === false) {
      cliente.analiseCadastro = {
        aprovado: row.analise_aprovado,
        avaliadoEm: row.analise_avaliado_em,
      };
    }

  return cliente;
}

export async function loadClientesFromSql(): Promise<ClientesDbShape> {
  const [base, endR] = await Promise.all([
    pgQuery("SELECT * FROM lanza.clientes ORDER BY nome"),
    pgQuery("SELECT * FROM lanza.cliente_enderecos"),
  ]);
  const endByCliente = new Map(endR.rows.map((row) => [String(row.cliente_id), row]));
  const clientes = base.rows.map((row) =>
    buildClienteRowFromSql(row as Record<string, unknown>, endByCliente.get(String(row.id))),
  );

  return {
    descricao: DEFAULT_CLIENTES_DESC,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    clientes,
  };
}

export type ClientesSqlFilter = {
  ids?: string[];
  cpf?: string;
  /** CPF, nome parcial ou id. */
  q?: string;
  ativo?: boolean;
};

/** Listagem filtrada de clientes (sem carregar catálogo inteiro). */
export async function queryClientesFromSql(filter: ClientesSqlFilter = {}): Promise<ClienteRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  let p = 1;

  const ids = [...new Set((filter.ids ?? []).map((id) => id.trim()).filter((id) => isUuid(id)))];
  if (ids.length === 1) {
    params.push(ids[0]);
    where.push(`c.id::text = $${p++}`);
  } else if (ids.length > 1) {
    params.push(ids);
    where.push(`c.id::text = ANY($${p++}::text[])`);
  }

  if (!ids.length && filter.cpf?.trim()) {
    const cpf = normCpf(filter.cpf.trim());
    if (cpf) {
      params.push(cpf);
      where.push(`c.cpf_norm = $${p++}`);
    }
  }

  const q = filter.q?.trim();
  if (!ids.length && q) {
    if (isUuid(q)) {
      params.push(q);
      where.push(`c.id::text = $${p++}`);
    } else {
      const cpfQ = normCpf(q);
      if (cpfQ?.length === 11) {
        params.push(cpfQ);
        where.push(`c.cpf_norm = $${p++}`);
      } else {
        params.push(`%${q.toLowerCase()}%`);
        where.push(`lower(c.nome) LIKE $${p++}`);
      }
    }
  }

  if (filter.ativo === true) {
    where.push(`(c.ativo IS DISTINCT FROM false)`);
  } else if (filter.ativo === false) {
    where.push(`(c.ativo = false)`);
  }

  if (where.length === 0) {
    return (await loadClientesFromSql()).clientes;
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [base, endR] = await Promise.all([
    pgQuery(`SELECT c.* FROM lanza.clientes c ${whereSql} ORDER BY c.nome`, params),
    ids.length > 0
      ? pgQuery("SELECT * FROM lanza.cliente_enderecos WHERE cliente_id::text = ANY($1::text[])", [
          ids.length === 1 ? [ids[0]] : ids,
        ])
      : pgQuery(
          `SELECT e.* FROM lanza.cliente_enderecos e
           INNER JOIN lanza.clientes c ON c.id = e.cliente_id
           ${whereSql}`,
          params,
        ),
  ]);
  const endByCliente = new Map(endR.rows.map((row) => [String(row.cliente_id), row]));
  return base.rows.map((row) =>
    buildClienteRowFromSql(row as Record<string, unknown>, endByCliente.get(String(row.id))),
  );
}

export type VeiculosSqlFilter = {
  ids?: string[];
  veiculoId?: string;
  placa?: string;
  ativo?: boolean;
  /** @deprecated Use tipoFrota */
  particular?: boolean;
  tipoFrota?: string;
};

/** Veículos filtrados — sem join FIPE (listagens/enriquecimento). */
export async function queryVeiculosFromSql(filter: VeiculosSqlFilter = {}): Promise<VeiculoRow[]> {
  const ids = new Set(
    (filter.ids ?? []).map((id) => id.trim()).filter((id) => isUuid(id)),
  );
  if (filter.veiculoId?.trim() && isUuid(filter.veiculoId.trim())) {
    ids.add(filter.veiculoId.trim());
  }
  if (filter.placa?.trim()) {
    const id = await resolveVeiculoIdFromSql({ placa: filter.placa });
    if (id) ids.add(id);
  }
  if (ids.size > 0) {
    return queryVeiculosByIdsFromSql([...ids]);
  }

  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.ativo === true) {
    where.push(`(v.ativo IS DISTINCT FROM false)`);
  } else if (filter.ativo === false) {
    where.push(`(v.ativo = false)`);
  }
  if (filter.tipoFrota?.trim()) {
    params.push(filter.tipoFrota.trim().toLowerCase());
    where.push(`(v.tipo_frota = $${params.length})`);
  } else if (filter.particular === true) {
    where.push(`(v.tipo_frota = 'particular' OR v.particular IS TRUE)`);
  } else if (filter.particular === false) {
    where.push(`(v.tipo_frota = 'locacao' OR (v.tipo_frota IS NULL AND v.particular IS NOT TRUE))`);
  }

  if (where.length === 0) {
    return (await loadVeiculosFromSqlLight()).veiculos;
  }

  const r = await pgQuery(
    `SELECT v.* FROM lanza.veiculos v WHERE ${where.join(" AND ")} ORDER BY v.placa`,
    params,
  );
  return r.rows.map((row) => rowToVeiculo(row as Record<string, unknown>));
}

/** Cliente mínimo para baixa/recebimento (sem endereço — 1 query). */
export async function loadClienteByIdBaixaFromSql(id: string): Promise<ClienteRow | null> {
  const key = id.trim();
  if (!isUuid(key)) return null;
  const r = await pgQuery(
    "SELECT id, nome, cpf, rg, telefone, email FROM lanza.clientes WHERE id::text = $1 LIMIT 1",
    [key],
    "loadClienteByIdBaixaFromSql",
  );
  const row = r.rows[0];
  if (!row) return null;
  return buildClienteRowFromSql(row as Record<string, unknown>, undefined);
}

/** Clientes por UUID (sem carregar catálogo inteiro). */
export async function loadClientesByIdsFromSql(ids: string[]): Promise<ClienteRow[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => isUuid(id)))];
  if (unique.length === 0) return [];

  const base = await pgQuery(
    "SELECT * FROM lanza.clientes WHERE id::text = ANY($1::text[]) ORDER BY nome",
    [unique],
    "loadClientesByIdsFromSql/clientes",
  );
  const endR = await pgQuery(
    "SELECT * FROM lanza.cliente_enderecos WHERE cliente_id::text = ANY($1::text[])",
    [unique],
    "loadClientesByIdsFromSql/enderecos",
  );
  const endByCliente = new Map(endR.rows.map((row) => [String(row.cliente_id), row]));
  return base.rows.map((row) =>
    buildClienteRowFromSql(row as Record<string, unknown>, endByCliente.get(String(row.id))),
  );
}

/** Resolve CPF, nome ou id → UUID do cliente (SQL direto, sem catálogo em memória). */
export async function resolveClienteIdFromSql(input: {
  clienteId?: string | null;
  clienteQuery?: string | null;
  cpf?: string | null;
}): Promise<string | null> {
  const id = input.clienteId?.trim();
  if (id && isUuid(id)) {
    const r = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.clientes WHERE id::text = $1 LIMIT 1",
      [id],
      "resolveClienteIdFromSql/byId",
    );
    return r.rows[0]?.id ?? null;
  }

  const cpfRaw = input.cpf?.trim() ?? "";
  const cpfNorm = cpfRaw ? normCpf(cpfRaw) : null;
  if (cpfNorm?.length === 11) {
    const r = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.clientes WHERE cpf_norm = $1 LIMIT 2",
      [cpfNorm],
      "resolveClienteIdFromSql/byCpf",
    );
    if (r.rows.length === 1) return r.rows[0]!.id;
    return null;
  }

  const query = input.clienteQuery?.trim();
  if (!query) return null;

  if (isUuid(query)) {
    const r = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.clientes WHERE id::text = $1 LIMIT 1",
      [query],
      "resolveClienteIdFromSql/queryAsId",
    );
    return r.rows[0]?.id ?? null;
  }

  const cpfFromQuery = normCpf(query);
  if (cpfFromQuery?.length === 11) {
    const r = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.clientes WHERE cpf_norm = $1 LIMIT 2",
      [cpfFromQuery],
      "resolveClienteIdFromSql/queryAsCpf",
    );
    if (r.rows.length === 1) return r.rows[0]!.id;
  }

  const r = await pgQuery<{ id: string }>(
    "SELECT id FROM lanza.clientes WHERE lower(nome) LIKE $1 LIMIT 2",
    [`%${query.toLowerCase()}%`],
    "resolveClienteIdFromSql/byNome",
  );
  if (r.rows.length === 1) return r.rows[0]!.id;
  return null;
}

/** Resolve placa ou UUID → veiculoId (SQL direto). */
export async function resolveVeiculoIdFromSql(input: {
  veiculoId?: string | null;
  placa?: string | null;
}): Promise<string | null> {
  const id = input.veiculoId?.trim();
  if (id && isUuid(id)) {
    const r = await pgQuery<{ id: string }>(
      "SELECT id FROM lanza.veiculos WHERE id::text = $1 LIMIT 1",
      [id],
      "resolveVeiculoIdFromSql/byId",
    );
    return r.rows[0]?.id ?? null;
  }

  const placa = input.placa?.trim();
  if (!placa) return null;

  const r = await pgQuery<{ id: string }>(
    "SELECT id FROM lanza.veiculos WHERE placa_norm = $1 LIMIT 2",
    [compactPlaca(placa)],
    "resolveVeiculoIdFromSql/byPlaca",
  );
  if (r.rows.length === 1) return r.rows[0]!.id;
  return null;
}

/** Veículos por UUID — sem join FIPE (suficiente para cobrança/baixa). */
export async function queryVeiculosByIdsFromSql(ids: string[]): Promise<VeiculoRow[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => isUuid(id)))];
  if (unique.length === 0) return [];

  const r = await pgQuery(
    `SELECT v.*
     FROM lanza.veiculos v
     WHERE v.id::text = ANY($1::text[])
     ORDER BY v.placa`,
    [unique],
    "queryVeiculosByIdsFromSql",
  );
  return r.rows.map((row) => rowToVeiculo(row as Record<string, unknown>));
}

export async function saveClientesToSql(db: ClientesDbShape): Promise<void> {
  for (const c of db.clientes) {
    await upsertClienteToSql(c as Record<string, unknown>);
  }
}

/** Grava ou atualiza um único cliente no Postgres (sem reescrever toda a tabela). */
export async function upsertClienteToSql(c: Record<string, unknown>): Promise<void> {
  const id = String(c.id);
  const cpf = c.cpf != null ? String(c.cpf) : null;
  const analise = c.analiseCadastro as Record<string, unknown> | undefined;
  const analiseAprovado =
    analise?.aprovado === true ? true : analise?.aprovado === false ? false : null;
  const analiseAvaliadoEm = analise?.avaliadoEm ?? null;
  await pgWriteQuery(
    `INSERT INTO lanza.clientes (
        id, nome, cpf, cpf_norm, rg, rg_orgao_expedidor, data_nascimento, local_nascimento,
        filiacao, telefone, email, cnh_arquivo, pasta_contrato_origem, origem_importacao,
        rastreame_motorista_key, rastreame_motorista_id, rastreame_sync_em, ativo,
        analise_aprovado, analise_avaliado_em, atualizado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome, cpf = EXCLUDED.cpf, telefone = EXCLUDED.telefone, ativo = EXCLUDED.ativo,
        rastreame_motorista_key = EXCLUDED.rastreame_motorista_key,
        rastreame_motorista_id = EXCLUDED.rastreame_motorista_id,
        rastreame_sync_em = EXCLUDED.rastreame_sync_em,
        analise_aprovado = EXCLUDED.analise_aprovado,
        analise_avaliado_em = EXCLUDED.analise_avaliado_em,
        atualizado_em = now()`,
    [
      id,
      c.nome,
      cpf,
      normCpf(cpf),
      c.rg ?? null,
      c.rgOrgaoExpedidor ?? null,
      c.dataNascimento ?? null,
      c.localNascimento ?? null,
      c.filiacao ?? null,
      c.telefone ?? null,
      c.email ?? null,
      c.cnhArquivo ?? null,
      c.pastaContratoOrigem ?? null,
      c.origemImportacao ?? null,
      c.rastreameMotoristaKey != null ? String(c.rastreameMotoristaKey) : null,
      c.rastreameMotoristaId != null ? String(c.rastreameMotoristaId) : null,
      c.rastreameSyncEm ?? null,
      c.ativo !== false,
      analiseAprovado,
      analiseAvaliadoEm,
    ],
  );

  const cnh = c.cnh as Record<string, unknown> | undefined;
  const cnhFields = pickCnhFields(cnh, c.cnhArquivo != null ? String(c.cnhArquivo) : null);
  if (cnhFields) {
    await upsertClienteCnh((sql, params) => pgQuery(sql, params), id, cnhFields);
  }

  const end = c.endereco as Record<string, unknown> | undefined;
  if (end) {
    await pgWriteQuery(
      `INSERT INTO lanza.cliente_enderecos (cliente_id, cep, logradouro, numero, complemento, bairro, cidade, uf, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (cliente_id) DO UPDATE SET cep = EXCLUDED.cep, logradouro = EXCLUDED.logradouro, atualizado_em = now()`,
      [
        id,
        end.cep ?? null,
        end.logradouro ?? null,
        end.numero ?? null,
        end.complemento ?? null,
        end.bairro ?? null,
        end.cidade ?? null,
        end.uf ?? null,
      ],
    );
  }

  if (c.cnhStorageKey != null || c.cnhDocumentoNome != null || c.comprovanteStorageKey != null || c.comprovanteDocumentoNome != null) {
    try {
      await pgWriteQuery(
        `UPDATE lanza.clientes SET
          cnh_storage_key = COALESCE($2, cnh_storage_key),
          cnh_documento_nome = COALESCE($3, cnh_documento_nome),
          comprovante_storage_key = COALESCE($4, comprovante_storage_key),
          comprovante_documento_nome = COALESCE($5, comprovante_documento_nome),
          atualizado_em = now()
        WHERE id = $1`,
        [
          id,
          c.cnhStorageKey != null ? String(c.cnhStorageKey) : null,
          c.cnhDocumentoNome != null ? String(c.cnhDocumentoNome) : null,
          c.comprovanteStorageKey != null ? String(c.comprovanteStorageKey) : null,
          c.comprovanteDocumentoNome != null ? String(c.comprovanteDocumentoNome) : null,
        ],
      );
    } catch {
      /* migration 027 opcional */
    }
  }
}
