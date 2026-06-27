# Tool — FIPE (Tabela FIPE de carros)

Consulta da **Tabela FIPE** via API pública [parallelum](https://fipe.parallelum.com.br) (`/api/v2/cars`). Sem autenticação. Reutilizável por skills (`cadastro-veiculo`) e por outros fluxos que precisem de marca/modelo/ano/valor FIPE.

Skills que **usam** esta tool: `cadastro-veiculo` (preenche `fipe`, `fipeCodigo`, `fipeModelo`, `fipeValor`, `fipeReferencia` em `database/veiculos.json`).

## Código (`src/lib/fipe/`)

| Módulo | Função |
|--------|--------|
| `client.ts` | HTTP de baixo nível (`fipeGet`), constantes e tipos (`FipeMarca`, `FipeModelo`, `FipeAno`, `FipeValor`). |
| `consulta.ts` | `listarMarcas`, `listarModelos`, `listarAnos`, `consultarValor`, `montarUrlFipe`, `slugMarca`, `refParaMesano`. |
| `resolverVeiculo.ts` | `resolverFipeVeiculo(v, brands?)` — resolução automática a partir de `marcaModelo`/`fipeModelo`/`anoModelo`; `EXTRAS_BY_PLACA` para ajustes manuais. |
| `index.ts` | Barrel — `import { ... } from "../lib/fipe/index.js"`. |

## Uso programático (skills/CLIs)

```ts
import { resolverFipeVeiculo, listarMarcas } from "../lib/fipe/index.js";

// Um veículo:
const r = await resolverFipeVeiculo({ placa: "AVU-6740", marcaModelo: "VW/GOL", anoModelo: "2013/2013" });
// r = { fipe, fipeCodigo, fipeModelo, fipeValor, fipeReferencia }

// Vários veículos (reaproveita a lista de marcas):
const brands = await listarMarcas();
for (const v of veiculos) await resolverFipeVeiculo(v, brands);
```

## Comandos CLI

```bash
npx tsx src/run.ts fipe marca "<texto>"
npx tsx src/run.ts fipe modelos <marcaCode> [filtro...]
npx tsx src/run.ts fipe anos <marcaCode> <modeloCode> [filtro]
npx tsx src/run.ts fipe valor <marcaCode> <modeloCode> <anoCode>

# Resolução automática em lote sobre database/veiculos.json:
npx tsx src/run.ts atualizar-fipe-veiculos [--placa PLACA]
```

## Mapa skill → comando

| Skill | Objetivo | Comando / API |
|-------|----------|---------------|
| cadastro-veiculo | Preencher FIPE de um veículo novo | `atualizar-fipe-veiculos --placa …` (automático no `merge-veiculo`) ou `resolverFipeVeiculo(...)` |
| cadastro-veiculo | Consulta manual de código/valor | `fipe marca\|modelos\|anos\|valor` |

## Notas

- A resolução é **heurística** (pontuação por tokens de modelo, cilindrada, portas, ano). Em divergência, refine `marcaModelo`/`fipeModelo` no JSON ou ajuste `EXTRAS_BY_PLACA` em `src/lib/fipe/resolverVeiculo.ts` e rode de novo.
- `fipeGet` usa `rejectUnauthorized: false` (compatível com ambientes com interceptação TLS).
- **Veículos inativos (`ativo === false`) são ignorados** na resolução em lote (passo FIPE do `sync-rastreaveis` e `atualizar-fipe-veiculos` sem `--placa`). Não fazemos consulta externa para frota inativa — ver regra "Veículos inativos" em `.cursor/rules/lanza-tools.mdc`. Para forçar um inativo específico, use `atualizar-fipe-veiculos --placa PLACA`.

## Extensão

Novo endpoint FIPE: função em `src/lib/fipe/consulta.ts` (ou novo módulo), re-export no `index.ts`, subcomando em `src/cli/fipe.ts` se precisar de CLI.
