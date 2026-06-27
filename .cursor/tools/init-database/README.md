# Tool: init-database — (re)construção do `database/`

Ponto central para **reinicializar / restaurar** os ficheiros `database/*.json` a partir das
fontes de verdade (documentos no Dropbox + Rastreame + DETRAN SC + Pedágio Digital + FIPE).

Use quando:

- **Perda de dados** em `database/` (corrupção, apagado, conflito de sync do Dropbox).
- **Máquina nova** / primeira utilização da aplicação.
- Quer **reconstruir do zero** um ou mais ficheiros mantendo as fontes externas.

> Princípio (ver pedido do projeto): os **scripts de importação não foram movidos** —
> continuam em `src/cli/` + `src/run.ts` porque são usados por skills/tools/hooks.
> Esta tool **referencia** cada um na ordem certa para o processo ser reexecutável.
> O **único** script que vive aqui é o `extrair-jpg-cnh.ts` (helper de inicialização,
> não usado por nenhuma skill).

Todos os comandos são **idempotentes** (merge por chave natural — CPF, placa, autoInfração)
e podem ser reexecutados sem duplicar.

---

## Origem de cada ficheiro `database/*.json`

| Ficheiro | Fonte de verdade | Comando(s) | Skill/Tool dona |
|---|---|---|---|
| `veiculos.json` | Rastreame (rastreáveis) → CRLV → FIPE | `sync-rastreaveis`, `sincronizar-veiculos-crlv`, `atualizar-fipe-veiculos`, `merge-veiculo` | `sync-veiculo`, `cadastro-veiculo` |
| `parceiros.json`, `parceiro-veiculo.json` | Dono informado no cadastro do veículo | `merge-veiculo <novo.json> <dono>` | `cadastro-veiculo` |
| `clientes.json` | Rastreame (motoristas) → CNH/contrato nas pastas | `sync-motoristas` / `importar-clientes-rastreame`, `importar-clientes-cnh` | `sync-cliente`, `cadastro-cliente` |
| `contratos.json` | Pastas `DD.MM.AAAA - Nome` em `documentosRaiz` | `importar-contratos` | `cadastro-contrato` |
| `cliente-despesas.json` | DETRAN (multas) + Pedágio + Rastreame Gastos Gerais | `sync-infracoes`, `sync-pedagios`, `sync-recebimentos` | `sync-infracoes`, `sync-pedagios`, `sync-recebimentos` |
| `parceiro-despesas.json` | DETRAN (IPVA/licenc.) + PDFs seguro + Rastreame Manutenção | `sync-ipva-licenciamento`, `sync-seguro`, `sync-manutencao` | `sync-ipva-licenciamento`, `sync-seguro` |
| `veiculos.json` → `inicioLocacoes` | Derivado de `cliente-despesas.json` | `inicio-locacoes derivar` | `sync-infracoes` |

Caminhos das fontes locais: **`config/lanza_paths.json`** (`documentosRaiz`, `seguroComprovantesDir`, …).

---

## Pré-requisitos

1. `npm install` na raiz do repositório.
2. **Credenciais nas variáveis de ambiente do utilizador** (não usar `.env`):
   - Rastreame: `RASTREAME_AUTH` (ou `RASTREAME_LOGIN` + `RASTREAME_SENHA`).
   - DETRAN SC e Pedágio Digital: token/sessão frescos (ver `.cursor/tools/detran-sc/` e
     `.cursor/tools/pedagio-digital/`). O **set destas variáveis é sempre permitido** (regra do projeto).
3. **Dropbox totalmente disponível offline** na pasta `documentosRaiz`
   (`D:/Dropbox/Aluguel Carros`). **Crítico:** pastas *online-only* (não hidratadas) são
   **puladas** na varredura (`fs.existsSync` falha) → contratos/clientes ficam por importar.
   No Dropbox: clicar com botão direito na pasta → **“Disponibilizar offline”** antes de correr.

Executar via: `npm run lanza -- <comando>` ou `.\scripts\lanza.ps1 <comando>` ou
`npx tsx src/run.ts <comando>`.

---

## Procedimento de reconstrução (ordem)

Faça `--dry-run` primeiro onde existir. A ordem respeita dependências (veículos antes de
contratos; despesas antes de `inicio-locacoes`).

### Fase 1 — Veículos e parceiros
```
npm run lanza -- sync-rastreaveis --dry-run
npm run lanza -- sync-rastreaveis            # pull/push rastreáveis do Rastreame
npm run lanza -- sincronizar-veiculos-crlv   # completa dados do CRLV (pastas)
npm run lanza -- atualizar-fipe-veiculos     # valor FIPE (só veículos ATIVOS)
```
Veículos avulsos não rastreados: `merge-veiculo <novo.json> "<Nome do dono>"`.

### Fase 2 — Clientes (locatários/motoristas)
```
npm run lanza -- sync-motoristas             # pull motoristas do Rastreame
npm run lanza -- importar-clientes-cnh --dry-run
npm run lanza -- importar-clientes-cnh       # nome/CPF/endereço do Contrato*.docx + CNH-e (texto)
```
- `importar-clientes-cnh` exige uma **CNH na pasta**; dados principais vêm do `Contrato*.docx`.
- CNH-e em PDF que seja **só imagem** não dá CPF por texto → ver **Passo assistido (CNH imagem)** abaixo.

### Fase 3 — Contratos
```
npm run lanza -- importar-contratos --dry-run
npm run lanza -- importar-contratos          # varre DD.MM.AAAA - Nome, infere encerramento pelo nome
```
- Re-resolve `clienteId`/`veiculoId` por CPF→nome a cada varredura (idempotente).
- Pastas *online-only* não varridas mantêm `clienteId: null` → **hidratar e reexecutar**.

### Fase 4 — Despesas do locatário (`cliente-despesas.json`)
Prioridade pela validade do token (ver regra dos syncs): **Pedágio primeiro**, depois DETRAN.
```
npm run lanza -- sync-pedagios --dry-run && npm run lanza -- sync-pedagios
npm run lanza -- sync-infracoes --dry-run && npm run lanza -- sync-infracoes
npm run lanza -- sync-recebimentos           # Gastos Gerais (OUTROS) do Rastreame
```

### Fase 5 — Despesas do parceiro (`parceiro-despesas.json`)
```
npm run lanza -- sync-ipva-licenciamento --dry-run && npm run lanza -- sync-ipva-licenciamento
npm run lanza -- sync-seguro --ano 2026      # PDFs em seguroComprovantesDir
npm run lanza -- sync-manutencao             # tela Manutenção do Rastreame
```

### Fase 6 — Datas de início de locação
```
npm run lanza -- inicio-locacoes derivar     # menor data por placa a partir de cliente-despesas.json
npm run lanza -- inicio-locacoes listar
```

---

## Passo assistido (CNH imagem) — `extrair-jpg-cnh.ts`

As CNH-e do SENATRAN normalmente são **PDF com a CNH embutida como imagem** (sem camada de
texto), então `importar-clientes-cnh` não consegue o CPF. Para esses casos o processo é
**assistido pelo agente** (precisa de visão):

1. Extrair as imagens embutidas do PDF:
   ```
   npx tsx .cursor/tools/init-database/extrair-jpg-cnh.ts "<caminho>/CNH-e.pdf" relatorios/_tmp/_cnh
   ```
   Gera `relatorios/_tmp/_cnh_0.jpg`, `_1.jpg`, … (o maior costuma ser a frente da CNH).
2. O agente **lê** a imagem e extrai nome, CPF, RG, nº registro, validade, filiação, etc.
3. Grava no `clientes.json` via `merge-cliente <cliente.json>` (ver skill `cadastro-cliente`).
4. Religar contratos: hidratar a pasta e reexecutar `importar-contratos`.

CNHs em `.jpg/.jpeg/.png` o agente lê diretamente (sem extrair).

**Guard de colisão de CPF:** antes de gravar, conferir se o CPF já pertence a outra pessoa em
`clientes.json` — contratos antigos por vezes têm o CPF errado (template reutilizado). Se
colidir, **não** sobrescrever; validar pela CNH qual registo está correto.

---

## Verificação final

Conferir vínculos e duplicados depois de reconstruir:

```powershell
# contratos sem clienteId e CPFs duplicados
npx tsx -e "import('./src/lib/contratosDb.js').then(async m=>{const d=m.loadContratosDb();const s=d.contratos.filter(c=>!c.clienteId);console.log('contratos',d.contratos.length,'sem clienteId',s.length);s.forEach(c=>console.log(' -',c.clienteNome,c.placa));})"
```

- `contratos sem clienteId` só deve sobrar para pastas ainda *online-only* / sem CNH legível.
- `CPFs duplicados` deve ser **0** (chave natural).

---

## Notas

- **Inativos:** syncs externos (FIPE/Pedágio/DETRAN) **não** consultam veículos `ativo: false`
  (ver `lanza-tools`). Pull do Rastreame atualiza ativos e inativos.
- **Inativação nunca é empurrada** ao Rastreame (push só de ativos).
- Reexecução é segura: tudo faz upsert por CPF/placa/autoInfração.
- Índice das tools: [`../README.md`](../README.md).
