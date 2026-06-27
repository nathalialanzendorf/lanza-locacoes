import fs from "node:fs";
import path from "node:path";

import { compactPlaca, formatPlacaHyphen, placasIguais } from "../lib/placa.js";
import { REPO_ROOT } from "../lib/repoRoot.js";
import { interactiveBrowserLogin } from "../lib/pedagioDigital/browserLogin.js";
import {
  extrairPassagens,
  listarPassagens,
  type PassagemStatus,
} from "../lib/pedagioDigital/passagens.js";
import { loadPlacasParaSync } from "../lib/pedagioDigital/syncPedagios.js";
import {
  excluirPlacaPorPlaca,
  listarVeiculos,
  marcaDeMarcaModelo,
  registrarPlaca,
} from "../lib/pedagioDigital/veiculos.js";

type VeiculoLocal = {
  placa?: string;
  marcaModelo?: string;
  modelo?: string;
  marca?: string;
  ano?: number | string;
  anoModelo?: string;
  cor?: string;
};

type DadosPlaca = {
  modelo: string;
  marca?: string;
  ano?: number | string;
  cor?: string;
};

/** Modelo do veículo: usa `modelo`; senão a parte após a "/" de `marcaModelo`. */
function modeloDeVeiculo(v: VeiculoLocal): string {
  if (v.modelo?.trim()) return v.modelo.trim();
  const mm = String(v.marcaModelo ?? "").trim();
  const aposBarra = mm.includes("/") ? mm.split("/").slice(1).join("/").trim() : mm;
  return aposBarra || marcaDeMarcaModelo(mm);
}

/**
 * Compõe o `modelo` enviado ao portal — único campo que o `register` persiste —
 * concatenando modelo + marca + ano + cor (ex.: "GOL 1.0 VOLKSWAGEN 2013 PRATA").
 */
function modeloComposto(d: DadosPlaca): string {
  return [d.modelo, d.marca, d.ano, d.cor]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean)
    .join(" ");
}

/** Dados do veículo (modelo, marca, ano, cor) de veiculos.json para o cadastro no portal. */
function dadosPlaca(placa: string): DadosPlaca | null {
  try {
    const p = path.join(REPO_ROOT, "database", "veiculos.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { veiculos?: VeiculoLocal[] };
    const v = (j.veiculos ?? []).find((x) => x.placa && placasIguais(x.placa, placa));
    if (!v) return null;
    const modelo = modeloDeVeiculo(v);
    if (!modelo) return null;
    const ano = v.ano ?? (v.anoModelo ? v.anoModelo.split("/")[0]!.trim() : undefined);
    return {
      modelo,
      marca: v.marca?.trim() || marcaDeMarcaModelo(v.marcaModelo) || undefined,
      ano: ano || undefined,
      cor: v.cor?.toString().trim() || undefined,
    };
  } catch {
    return null;
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const HELP = `pedagio-digital <subcomando> [opções]

  login
      Abre o Chrome (janela visível) no pedagiodigital.com, preenche CPF+senha
      (de PEDAGIO_DIGITAL_LOGIN/SENHA) e espera você resolver o reCAPTCHA e
      entrar. Captura a sessão para .cache/ — os syncs passam a renová-la
      sozinhos (refresh silencioso pelo perfil). GRÁTIS, sem solver pago.

  register --placa PLACA [--modelo M] [--marca M] [--ano A] [--cor C]
      Cadastra a placa no pedagiodigital.com. O portal só persiste o campo
      'modelo', então a tool o compõe como "MODELO MARCA ANO COR" (dados de
      database/veiculos.json). Com --modelo explícito, usa o texto informado.
      Chamar após cadastro-veiculo em veículo NOVO.

  delete --placa PLACA [--dry-run]
      Exclui a placa do pedagiodigital.com. Chamar ao INATIVAR um veículo
      (ativo: false) — não cobramos pedágio de veículo fora de locação.

  veiculos
      Lista as placas cadastradas na conta.

  conferir [--registrar]
      Compara database/veiculos.json com as placas do portal e mostra as que
      faltam cadastrar. Com --registrar, cadastra as faltantes (register).

  passagens --placa PLACA [--status aberto|pago|todos] [--json arquivo.json]
      Lista passagens da placa (online) ou processa um JSON capturado.

Variáveis de ambiente do utilizador: PEDAGIO_DIGITAL_LOGIN (CPF), PEDAGIO_DIGITAL_SENHA`;

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "-h" || sub === "--help") {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case "login": {
      const session = await interactiveBrowserLogin();
      if (session) {
        console.log("OK login pedagiodigital — sessão capturada e cacheada em .cache/pedagio-digital/.");
        console.log("Agora rode os syncs normalmente (a sessão renova sozinha enquanto o perfil continuar válido).");
      } else {
        console.error("Falha: login não concluído (tempo esgotado ou janela fechada).");
        process.exit(1);
      }
      return;
    }

    case "register": {
      const placa = arg(rest, "--placa");
      if (!placa) {
        console.error("Informe --placa");
        process.exit(1);
      }
      const d = dadosPlaca(placa);
      const marca = arg(rest, "--marca") ?? d?.marca;
      const ano = arg(rest, "--ano") ?? d?.ano;
      const cor = arg(rest, "--cor") ?? d?.cor;
      const modeloArg = arg(rest, "--modelo");
      const modeloBase = modeloArg ?? d?.modelo;
      if (!modeloBase) {
        console.error(
          `Não foi possível determinar o modelo para ${formatPlacaHyphen(placa)}; passe --modelo.`,
        );
        process.exit(1);
      }
      // `modelo` é o único campo persistido no portal → compõe modelo+marca+ano+cor.
      // Com --modelo explícito, respeita o texto informado.
      const modelo = modeloArg ?? modeloComposto({ modelo: modeloBase, marca, ano, cor });
      const r = await registrarPlaca({ placa, modelo, marca, ano, cor });
      if (r.ok) {
        console.log(`OK ${r.placa} cadastrada (modelo="${modelo}").`);
      } else {
        console.error(`Falha (${r.status}) ${r.placa}: ${r.body.slice(0, 300)}`);
        process.exit(1);
      }
      return;
    }

    case "delete": {
      const placa = arg(rest, "--placa");
      if (!placa) {
        console.error("Informe --placa");
        process.exit(1);
      }
      if (rest.includes("--dry-run")) {
        const lista = await listarVeiculos();
        const v = lista.find((x) => placasIguais(x.placa, placa));
        console.log(
          v?.id
            ? `[dry-run] excluiria ${formatPlacaHyphen(placa)} do portal (id=${v.id}).`
            : `[dry-run] ${formatPlacaHyphen(placa)} não está no portal — nada a excluir.`,
        );
        return;
      }
      const r = await excluirPlacaPorPlaca(placa);
      if (r.naoEncontrada) {
        console.log(`${r.placa} não está no portal — nada a excluir.`);
      } else if (r.ok) {
        console.log(`OK ${r.placa} excluída do portal (id=${r.id}).`);
      } else {
        console.error(`Falha (${r.status}) ${r.placa}: ${r.body.slice(0, 200)}`);
        process.exit(1);
      }
      return;
    }

    case "veiculos": {
      const lista = await listarVeiculos();
      console.log(`${lista.length} placa(s):`);
      for (const v of lista) console.log(`  ${v.placa}${v.modelo ? ` (${v.modelo})` : ""}`);
      return;
    }

    case "conferir": {
      const registrar = rest.includes("--registrar");
      const locais = loadPlacasParaSync();
      const portal = await listarVeiculos();
      const portalSet = new Set(portal.map((v) => compactPlaca(v.placa)));
      const localSet = new Set(locais.map((p) => compactPlaca(p)));

      const faltam = locais.filter((p) => !portalSet.has(compactPlaca(p)));
      const extras = portal.filter((v) => !localSet.has(compactPlaca(v.placa)));

      console.log(`Local (veiculos.json): ${locais.length} | Portal: ${portal.length}`);
      console.log(`Cadastradas no portal: ${locais.length - faltam.length}/${locais.length}`);

      if (faltam.length === 0) {
        console.log("OK: todos os veículos do veiculos.json estão no pedagiodigital.com.");
      } else {
        console.log(`\nFALTAM no portal (${faltam.length}):`);
        for (const p of faltam) console.log(`  ${formatPlacaHyphen(p)}`);
      }
      if (extras.length) {
        console.log(`\nNo portal mas não em veiculos.json (${extras.length}):`);
        for (const v of extras) console.log(`  ${v.placa}${v.modelo ? ` (${v.modelo})` : ""}`);
      }

      if (registrar && faltam.length) {
        console.log(`\nCadastrando ${faltam.length} placa(s) faltante(s)...`);
        for (const p of faltam) {
          const d = dadosPlaca(p);
          if (!d?.modelo) {
            console.error(`  ${formatPlacaHyphen(p)}: sem modelo em veiculos.json (use register --modelo manual).`);
            continue;
          }
          const modelo = modeloComposto(d);
          try {
            const r = await registrarPlaca({ placa: p, modelo, marca: d.marca, ano: d.ano, cor: d.cor });
            console.log(`  ${r.ok ? "OK" : `FALHA ${r.status}`} ${r.placa} (modelo="${modelo}")`);
          } catch (e) {
            console.error(`  ${formatPlacaHyphen(p)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return;
    }

    case "passagens": {
      const placa = arg(rest, "--placa");
      if (!placa) {
        console.error("Informe --placa");
        process.exit(1);
      }
      const status = (arg(rest, "--status") as PassagemStatus) ?? "todos";
      const jsonIn = arg(rest, "--json");
      const passagens = jsonIn
        ? extrairPassagens(JSON.parse(fs.readFileSync(path.resolve(jsonIn), "utf8")))
        : await listarPassagens(placa, { status });
      const filtradas = passagens.filter(
        (p) => placasIguais(p.placa || placa, placa),
      );
      console.log(`${filtradas.length} passagem(ns) (${status}) para ${formatPlacaHyphen(placa)}:`);
      for (const p of filtradas) {
        console.log(
          `  ${p.emAberto ? "ABERTO" : "PAGO  "} | ${p.dataHoraRaw || p.dataHoraIso} | R$ ${p.valor} | ${p.praca ?? ""} | id=${p.id}`,
        );
      }
      return;
    }

    default:
      console.error(`Subcomando desconhecido: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}
