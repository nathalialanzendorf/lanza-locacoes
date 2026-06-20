# Sistema multiagente (Lanza)

Este diretório define um **sistema multiagente**: vários **papéis** (cada um com prompt e responsabilidade próprios), com **saída estruturada** de um passo servindo de **entrada** do próximo. Isso é diferente de uma **skill** sozinha, que é só um manual único.

## Relação com `.cursor/skills/`

- **Skills** (`../.cursor/skills/contrato/`): documentação reutilizável (formato do contrato, âncoras no DOCX, pastas).
- **Multiagente aqui**: quem **executa** o fluxo; o montador pode **incorporar** trechos da skill no prompt, mas o “sistema” é o **orquestrador + etapas**.

## Papéis (agentes)

| Agente | Função | Entrada | Saída esperada |
|--------|--------|---------|----------------|
| **1 — Extrator** | Ler CNH + comprovante (paths ou imagens já no repo) e transcrever dados sem inventar. | Caminhos dos arquivos + notas do usuário | JSON estrito (schema em `ORCHESTRATION.md`) |
| **2 — Montador** | Montar texto do LOCATÁRIO + checklist de arquivos/pastas alinhado ao modelo v3. | JSON do extrator + regras da skill contrato | Markdown: parágrafo LOCATÁRIO + nome para assinatura + linha sugerida de data |
| **3 — Revisor** | Conferir consistência (nome/CPF/endereço) e apontar riscos antes de editar o DOCX. | JSON + saída do montador | Lista pass/fail + correções sugeridas |

Opcional depois: **4 — Executor técnico** (mesmo modelo ou script) só para descompactar `.docx`, substituir XML e rezipar — hoje pode ser manual no Word conforme o revisor aprovar.

## Duas formas de rodar

### A) Manual no Cursor (sem código)

Siga a ordem em `ORCHESTRATION.md`: abra três conversas ou uma só com três blocos “AGORA VOCÊ É O AGENTE X”, colando a saída anterior cada vez. Use os arquivos em `prompts/`.

### B) Automático com Cursor SDK

Veja `cursor-sdk-example/README.md`: um script dispara **três** `Agent.prompt` em sequência no mesmo repositório (`cwd`), injetando os prompts desta pasta.

## Privacidade

CNH, CPF e endereço: não commitar saídas com dados reais; use `.gitignore` para artefatos locais se o script gravar JSON em disco.
