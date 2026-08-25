import crypto from "node:crypto";



import {

  editarVeiculoAsync,

  excluirVeiculoAsync,

  formatPlacaHyphen,

  isVeiculoAtivo,

  loadVeiculosDb,

  loadVeiculosDbAsync,

  placasIguais,

  findVeiculoInDb,

  isEntityUuid,

  replicarVeiculoNoRastreame,

  saveVeiculosDbAsync,

  type VeiculoPatch,

  type VeiculoRegistro,

} from "../lib-imports.js";

import { upsertVeiculoToSql, useRelationalStore } from "@lanza/db";

import {

  isTipoVeiculoFrotaValor,

  parseTipoVeiculoFrota,

  particularLegadoDeTipoFrota,

  tipoFrotaDeVeiculo,

  type TipoVeiculoFrotaValor,

} from "../../../../src/lib/domain/tipoVeiculoFrota.js";

import { HttpError } from "../http.js";

import { criarParceiroAsync, vincularVeiculoParceiroAsync } from "./parceiros.js";



export type ListarVeiculosOpts = {

  ativo?: boolean;

  placa?: string;

  /** @deprecated Use tipoFrota */

  particular?: boolean;

  tipoFrota?: TipoVeiculoFrotaValor;

  /** Inclui join com `lanza.veiculo_fipe` (relatório FIPE). */

  comFipe?: boolean;

};



function resolveTipoFrotaFilter(opts: ListarVeiculosOpts): TipoVeiculoFrotaValor | undefined {

  if (opts.tipoFrota && isTipoVeiculoFrotaValor(opts.tipoFrota)) {

    return parseTipoVeiculoFrota(opts.tipoFrota);

  }

  if (opts.particular === true) return "particular";

  if (opts.particular === false) return "locacao";

  return undefined;

}



export function listarVeiculos(opts: ListarVeiculosOpts = {}): {

  total: number;

  items: VeiculoRegistro[];

} {

  return filtrarVeiculos(loadVeiculosDb().veiculos, opts);

}



export async function listarVeiculosAsync(opts: ListarVeiculosOpts = {}): Promise<{

  total: number;

  items: VeiculoRegistro[];

}> {

  const tipoFrota = resolveTipoFrotaFilter(opts);

  const db = await loadVeiculosDbAsync({

    placa: opts.placa,

    ativo: opts.ativo,

    particular: opts.particular,

    tipoFrota,

    comFipe: opts.comFipe === true,

  });

  return filtrarVeiculos(db.veiculos, opts);

}



function filtrarVeiculos(

  veiculos: VeiculoRegistro[],

  opts: ListarVeiculosOpts,

): { total: number; items: VeiculoRegistro[] } {

  if (opts.placa?.trim()) {

    const um = veiculos.find((v) => placasIguais(v.placa, opts.placa!));

    const items = um ? [um] : [];

    return { total: items.length, items };

  }



  let items = veiculos;



  if (opts.ativo === true) {

    items = items.filter(isVeiculoAtivo);

  } else if (opts.ativo === false) {

    items = items.filter((v) => !isVeiculoAtivo(v));

  }



  const tipoFrota = resolveTipoFrotaFilter(opts);

  if (tipoFrota) {

    items = items.filter((v) => tipoFrotaDeVeiculo(v) === tipoFrota);

  }



  return { total: items.length, items };

}



async function espelharVeiculoRastreame(v: VeiculoRegistro): Promise<void> {
  try {
    await replicarVeiculoNoRastreame(v);
  } catch (err) {
    console.error(
      `[veiculos] falha ao replicar no Rastreame (${v.placa}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}



export async function obterVeiculoAsync(idOuPlaca: string): Promise<VeiculoRegistro | null> {
  const key = idOuPlaca.trim();
  const db = await loadVeiculosDbAsync(isEntityUuid(key) ? { veiculoId: key } : { placa: key });
  return findVeiculoInDb(db, key);
}



export async function atualizarVeiculoAsync(

  idOuPlaca: string,

  patch: VeiculoPatch,

): Promise<VeiculoRegistro> {

  const item = await editarVeiculoAsync(idOuPlaca, patch);

  if (!item) {

    throw new HttpError(404, "Veículo não encontrado");

  }

  await espelharVeiculoRastreame(item);

  return (await obterVeiculoAsync(item.id)) ?? item;

}



export async function removerVeiculoAsync(idOuPlaca: string): Promise<VeiculoRegistro> {

  const item = await excluirVeiculoAsync(idOuPlaca);

  if (!item) {

    throw new HttpError(404, "Veículo não encontrado");

  }

  await espelharVeiculoRastreame(item);

  return (await obterVeiculoAsync(item.id)) ?? item;

}



export type CriarVeiculoInput = Partial<VeiculoRegistro> & {

  placa: string;

  parceiroNome?: string;

  parceiroId?: string;

  syncFipe?: boolean;

};



function tipoFrotaDeInput(input: Partial<VeiculoRegistro>): TipoVeiculoFrotaValor {

  if (input.tipoFrota != null && isTipoVeiculoFrotaValor(String(input.tipoFrota))) {

    return parseTipoVeiculoFrota(String(input.tipoFrota));

  }

  if (input.particular === true) return "particular";

  return "locacao";

}



export async function criarVeiculo(input: CriarVeiculoInput): Promise<{

  data: VeiculoRegistro;

  acao: "novo" | "atualizado";

  vinculo?: unknown;

}> {

  const placa = formatPlacaHyphen(input.placa);

  if (!placa) throw new HttpError(400, 'Campo "placa" é obrigatório');



  const tipoFrota = tipoFrotaDeInput(input);

  const db = await loadVeiculosDbAsync();

  const existente = db.veiculos.find((v) => placasIguais(v.placa, placa)) ?? null;

  const ts = new Date().toISOString();

  let acao: "novo" | "atualizado";

  let registro: VeiculoRegistro;



  if (existente) {

    const { parceiroNome: _pn, parceiroId: _pi, syncFipe: _sf, ...patchRaw } = input;

    const patch: VeiculoPatch = {

      ...patchRaw,

      ativo: input.ativo !== false,

      tipoFrota,

      particular: particularLegadoDeTipoFrota(tipoFrota),

    };

    const atualizado = await editarVeiculoAsync(existente.id, patch);

    if (!atualizado) throw new HttpError(500, "Falha ao atualizar veículo");

    registro = atualizado;

    acao = "atualizado";

  } else {

    const { placa: _p, parceiroNome: _pn, parceiroId: _pi, syncFipe: _sf, ...rest } = input;

    registro = {

      ...rest,

      id: crypto.randomUUID(),

      placa,

      ativo: input.ativo !== false,

      tipoFrota,

      particular: particularLegadoDeTipoFrota(tipoFrota),

      origem: (input.origem as string | undefined) ?? "api",

      atualizadoEm: ts,

    };

    if (await useRelationalStore()) {

      await upsertVeiculoToSql(registro as unknown as Record<string, unknown>);

    } else {

      db.veiculos.push(registro);

      await saveVeiculosDbAsync(db);

    }

    acao = "novo";

  }



  let vinculo = null;

  if (input.parceiroId) {

    vinculo = await vincularVeiculoParceiroAsync(registro.id, input.parceiroId);

  } else if (input.parceiroNome?.trim()) {

    const p = await criarParceiroAsync(input.parceiroNome.trim());

    vinculo = await vincularVeiculoParceiroAsync(registro.id, p.id);

  }



  if (input.syncFipe) {

    try {

      const { atualizarFipeVeiculo } = await import("./fipe.js");

      await atualizarFipeVeiculo(registro.placa);

      registro = (await obterVeiculoAsync(registro.id)) ?? registro;

    } catch {

      /* FIPE opcional */

    }

  }



  await espelharVeiculoRastreame(registro);

  registro = (await obterVeiculoAsync(registro.id)) ?? registro;



  return { data: registro, acao, vinculo };

}


