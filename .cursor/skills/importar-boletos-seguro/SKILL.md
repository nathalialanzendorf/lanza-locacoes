---

name: importar-boletos-seguro

description: >-

  Reads insurance bill PDFs under seguroComprovantesDir (see config/lanza_paths.json),

  extracts vehicle plate and premium amount, and writes Seguro expenses to

  database/despesas.json. Use when importing boletos de seguro, lote de seguros,

  comprovantes proteção veicular, or after adding PDFs to that folder.

---



# Importar Boletos de Seguro



Lê **comprovantes / boletos de seguro** (PDF), extrai **placa** e **valor**, grava em `database/despesas.json` (categoria `Seguro`). Alimenta **relatorio-prestacao-contas**.



## Onde estão os PDFs (canónico)



1. **Ler sempre primeiro** a pasta definida por **`seguroComprovantesDir`** em `config/lanza_paths.json` na raiz do repositório.

2. **Padrão atual:** `D:\Dropbox\Aluguel Carros\Proteção Veicular\Comprovantes\2026`

3. Listar **todos os `.pdf`** nessa pasta e, se existirem, **subpastas** (ex. `2026\06`, `2026\Junho`, por veículo, etc.) — não assumir só um nível de diretório.

4. Se o utilizador indicar outro caminho, prevalece para essa sessão; opcionalmente atualizar `seguroComprovantesDir` no JSON para fixar o novo padrão.



## Uso



- Preferir **um ficheiro PDF por veículo**; se existir `.jpg` e `.pdf` com o mesmo nome-base, usar só o **PDF** para extração de texto.

- `despesasRaiz` em `lanza_paths.json` serve para **outras despesas** em árvore `Despesas/...`; **não** substitui `seguroComprovantesDir` para seguros.



## Extração



| Campo | Onde |

|-------|------|

| `placa` | `PLACA(S): ...` e/ou nome do arquivo |

| `valor` | `( = ) Valor do Documento` / `(R$ xx,xx)` por placa |

| `data` | Vencimento DD/MM/AAAA |

| `competencia` | `CONTRIBUIÇÃO DO MÊS MM/AA` → `MM/AAAA` |



## Gravar



Montar lista JSON e executar (o ficheiro de entrada pode estar em `relatorios/` ou noutro caminho à escolha):



```bash

python ".cursor/skills/importar-boletos-seguro/scripts/gravar_despesas.py" "relatorios/_boletos_tmp.json"

```



Formato do JSON (array):



```json

[

  {"placa":"AVU6740","valor":74.85,"data":"10/06/2026","competencia":"06/2026",

   "origem":"Proteção Veicular/Comprovantes/2026/AVU6740 - GOL.pdf"}

]

```



`origem` deve ser **única por ficheiro** (caminho relativo a `documentosRaiz` em `lanza_paths.json`, ou caminho absoluto normalizado) para o `gravar_despesas.py` fazer dedupe na reimportação.



## Critério de conclusão



- Um registo por veículo sem duplicar jpg+pdf.

- `veiculoId` resolvido para o **uuid** do veículo ou `null` com aviso.



## Skills relacionadas



- **relatorio-prestacao-contas**, **cadastrar-veiculo**


