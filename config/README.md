# Caminhos Lanza (`lanza_paths.json`)

Este ficheiro define **onde estão os documentos no Dropbox**, fora do Git.

| Chave | Uso |
|-------|-----|
| `documentosRaiz` | Procurar CNH, CRLV, comprovantes e anexos; também pasta-mãe dos contratos por defeito. |
| `contratosDir` | Onde o `gerar_contrato.py` cria pastas `DD.MM.AAAA - Nome do cliente` (pode ser igual a `documentosRaiz`). |
| `financeiro` | Base para relatórios financeiros. |
| `prestacaoContasSubpasta` | Subpasta dentro de `financeiro` para os `.txt` de prestação (ex.: `prestação de contas`). |
| `despesasRaiz` | Raiz legada/outras despesas em `Despesas/...` (opcional). |
| `seguroComprovantesDir` | **PDFs dos boletos/comprovantes de seguro** (proteção veicular): ler e importar a partir desta pasta e subpastas. |

Se apagar o JSON, os scripts voltam ao comportamento antigo (pastas dentro do repositório Aworklanza).
