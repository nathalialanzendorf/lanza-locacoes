---
name: gerar-contrato
description: >-
  Generates the Lanza vehicle rental contract as Word (.docx) and PDF in a dated
  folder under contratos/, from templates/Contrato - Modelo v3.docx. Asks for
  vehicle, client, period, weekly rent, and deposit. Requires registered client
  and vehicle or can onboard them in-flow. Use when the user asks for contrato,
  locação, gerar contrato, or PDF do contrato.
---

# Gerar Contrato de Locação de Veículo

Gera **Contrato de Locação** a partir de `templates/Contrato - Modelo v3.docx`, atualizando **cliente**, **veículo**, **valores** e **prazo**. O modelo lista vários veículos na cláusula 1.1; o contrato gerado mantém **somente** o veículo escolhido. Na 1.1, o trecho **marca/modelo** do veículo é `marcaModelo` e, se existir `fipeModelo` em `database/veiculos.json` (ou no JSON de entrada), acrescenta-se ` (fipeModelo)` entre parênteses.

## Cadastro automático (se faltar)

- **Veículo:** se não existir em `database/veiculos.json`, seguir skill **cadastrar-veiculo** com o CRLV (caminho informado pelo usuário; **procurar primeiro** em `D:\Dropbox\Aluguel Carros` conforme `config/lanza_paths.json`, depois `%USERPROFILE%\Downloads\CRLV-e.pdf` se fizer sentido).
- **Cliente:** se não existir em `database/clientes.json`, seguir skill **cadastrar-cliente** com CNH + comprovante. A **mesma CNH** deve ir em `cnhArquivo` no JSON para copiar como `CNH.pdf` na pasta do contrato.

## Perguntas (ordem)

1. Veículo (placa em `veiculos.json`) ou cadastrar via CRLV.
2. Cliente (`clientes.json`) ou cadastrar via CNH.
3. **Período:** diária, 1 semana, 15 dias, 3 meses (padrão), 6 meses, 1 ano.
4. **Valor semanal** (R$).
5. **Caução** (R$).
6. **Data de início** (padrão: hoje), hora `18:00`.
7. **Dia de pagamento semanal** (cláusula 3.2): frase completa, ex. `todos os sábados`, `todas as segundas-feiras`.

### Período → dias

| Período | Dias |
|---------|------|
| diária | 1 |
| 1 semana | 7 |
| 15 dias | 15 |
| 3 meses (padrão) | 90 |
| 6 meses | 180 |
| 1 ano | 365 |

## Gerar (script)

Montar `dados.json` e executar (JSON de entrada pode ficar em `relatorios/` ou na raiz do repo):

```bash
python ".cursor/skills/gerar-contrato/scripts/gerar_contrato.py" "relatorios/_dados_contrato_tmp.json"
```

Exemplo de `dados.json` (use caminhos absolutos ou relativos ao cwd). Se **omitir** `contratosDir`, o script usa `config/lanza_paths.json` (`D:\Dropbox\Aluguel Carros` por defeito):

```json
{
  "template": "templates/Contrato - Modelo v3.docx",
  "contratosDir": "D:/Dropbox/Aluguel Carros",
  "cnhArquivo": "C:/Users/.../Downloads/CNH-e.pdf",
  "diaPagamento": "todos os sábados",
  "cliente": { "nome": "...", "cpf": "...",
    "endereco": {"logradouro":"...","numero":"...","complemento":"","bairro":"...","cidade":"...","uf":"SC","cep":"..."} },
  "veiculo": { "placa":"...","marcaModelo":"...","fipeModelo":"...","chassi":"...","renavam":"...","anoModelo":"...","cor":"...","fipe":"..." },
  "prazo":   { "dias": 90, "inicio": "19/06/2026", "hora": "18:00" },
  "valores": { "semana": 650, "caucao": 1500, "diaria": 120 },
  "cnhCategoria": "B",
  "assinatura": { "cidade": "Tubarão", "estado": "Santa Catarina", "data": "auto" }
}
```

O script cria `DD.MM.AAAA - Nome Cliente/` dentro de `contratosDir` (pasta operacional, p.ex. `D:\Dropbox\Aluguel Carros`) com `.docx`, `.pdf` (Word COM no Windows) e cópia da CNH se `cnhArquivo` existir.

## Dependências

Python: `python-docx`, `pywin32` (PDF no Windows).

## Skills relacionadas

- **cadastrar-cliente**, **cadastrar-veiculo**
- Skill **contrato** (`.cursor/skills/contrato`) — fluxo manual focado só no bloco LOCATÁRIO no mesmo modelo.
