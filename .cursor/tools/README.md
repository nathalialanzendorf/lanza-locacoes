# Ferramentas Lanza (tools)

Integrações externas e CLIs auxiliares. **Não são skills** — o agente consulta esta pasta quando precisa de auth, endpoints ou comandos de execução.

## Skills vs tools vs MCP

| Camada | Onde | Papel |
|--------|------|--------|
| **Skill** | `.cursor/skills/<nome>/SKILL.md` | Fluxo de **negócio** (cadastrar cliente, contrato, recebimento, relatório). O *quê* e *quando*. |
| **Tool** | `.cursor/tools/` + `src/lib/` + `src/run.ts` | **Integração técnica** (Rastreame, DETRAN SC). Auth, CLI, mapeamento API → JSON local. |
| **MCP** | Config Cursor (opcional) | Só se expuser APIs como servidor MCP; **neste repo** usamos CLI TypeScript, não MCP. |

Regra do projeto: skills de domínio **delegam execução** às tools (shell `npx tsx src/run.ts …`). Skills **`sync-infracoes`** e **`sync-ipva-licenciamento`** são fluxos de negócio que usam a tool DETRAN; **Rastreame** não tem skill dedicada — só tool.

## Índice

| Tool | Documentação | Código | CLI |
|------|--------------|--------|-----|
| **Rastreame** | [rastreame/README.md](rastreame/README.md) | `src/lib/rastreame/` | `rastreame`, `rastreame-gastos`, `importar-clientes-rastreame`, `rastreame-lancar-semanal`, `renegociar-debitos` |
| **DETRAN SC** | [detran-sc/README.md](detran-sc/README.md) | `src/lib/detranSc/` | `sync-infracoes`, `sync-ipva-licenciamento` (veículos `ufRegistro` SC/vazio) |
| **DETRAN RS** | [detran-rs/README.md](detran-rs/README.md) | `src/lib/detranRs/` | `sync-detran-rs` (IPVA/Licenciamento, veículos `ufRegistro="RS"`) |
| **FIPE** | [fipe/README.md](fipe/README.md) | `src/lib/fipe/` | `fipe`, `atualizar-fipe-veiculos` |
| **Pedágio Digital** | [pedagio-digital/README.md](pedagio-digital/README.md) | `src/lib/pedagioDigital/` | `sync-pedagios`, `pedagio-digital` |
| **Init Database** | [init-database/README.md](init-database/README.md) | `src/cli/` (referenciados) | (re)construção de `database/*.json` após perda de dados |

## Quando ler tools (checklist do agente)

1. Utilizador pede ação no **Rastreame** → `tools/rastreame/` (via skill de cadastro).
2. Utilizador pede **sync multas / infrações DETRAN** → skill **`sync-infracoes`** (+ tool `detran-sc/`).
3. Utilizador pede **sync IPVA / licenciamento DETRAN** → SC: skill **`sync-ipva-licenciamento`** (+ tool `detran-sc/`); RS (`ufRegistro="RS"`): CLI **`sync-detran-rs`** (+ tool `detran-rs/`).
4. Skill de cadastro manda “executar no site/API” → abrir tool, correr CLI, reportar stdout.

## Extensão

Nova integração externa:

1. Implementar em `src/lib/<nome>/`.
2. Expor em `src/run.ts`.
3. Documentar em `.cursor/tools/<nome>/README.md`.
4. Referenciar na skill de negócio; para DETRAN, manter skills `sync-infracoes` / `sync-ipva-licenciamento` que apontam à tool.
