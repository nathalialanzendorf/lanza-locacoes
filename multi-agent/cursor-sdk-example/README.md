# Orquestrador Cursor SDK (3 agentes em sequência)

Este exemplo **não** é uma skill: é um **programa** que chama o Cursor **três vezes** (`Agent.prompt`), cada uma com um papel diferente (Extrator → Montador → Revisor). Isso é o núcleo de um **sistema multiagente** simples.

## Pré-requisitos

- [Node.js 22.13+](https://nodejs.org/) (requisito documentado do `@cursor/sdk`)
- Chave `CURSOR_API_KEY` ([Integrações](https://cursor.com/dashboard/integrations))

## Instalação

```bash
cd multi-agent/cursor-sdk-example
npm install
```

## Uso

No PowerShell (use caminhos reais aos PDFs/JPGs da CNH e da residência — padrão do negócio: `D:\Dropbox\Aluguel Carros\...`):

```bash
$env:CURSOR_API_KEY = "cursor_..."
npm run contrato -- "D:/Dropbox/Aluguel Carros/19.06.2026 - Cliente/CNH.pdf" "D:/Dropbox/Aluguel Carros/19.06.2026 - Cliente/Residencia.jpg"
```

Ou:

```bash
node orchestrator.mjs "caminho/para/CNH.pdf" "caminho/para/Residencia.jpg"
```

O `cwd` do agente é a **raiz do repositório** `worklanza`, para que ferramentas encontrem `.cursor/skills/contrato/` e `templates/`.

## O que o script faz

1. Lê `multi-agent/prompts/01-extrator.md` e envia um `Agent.prompt` com os paths dos documentos.
2. Passa a resposta (esperado: JSON) para o segundo prompt com `02-montador.md`.
3. Passa JSON + markdown do montador para `03-revisor.md`.

Saídas vão para o **stdout**; você pode redirecionar para um arquivo local (não commitar dados pessoais).

## GitHub Actions

Guarde `CURSOR_API_KEY` em **Secrets**, faça `actions/checkout`, instale Node, `npm ci` nesta pasta e rode o mesmo comando. Para repositório privado, a chave precisa de acesso ao GitHub do time/conta.

## Limitações

- Cada `Agent.prompt` é um **novo** run sem memória compartilhada além do texto que o script encadeia.
- PDFs digitalizados: o agente local precisa conseguir extrair texto/visão conforme o runtime do Cursor; se falhar, use imagens nítidas ou etapa manual para o Extrator.
