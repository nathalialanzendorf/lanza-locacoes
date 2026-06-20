---
name: contrato
description: >-
  Cria ou atualiza contrato de locação Lanza a partir de CNH e comprovante de
  residência (PDF/JPG), preenchendo o bloco do LOCATÁRIO no modelo Word v3.
  Use quando o usuário pedir contrato, atualizar contrato, preencher contrato,
  locatário, CNH, comprovante de residência, ou trabalhar com
  templates/Contrato - Modelo v3.docx.
---

# Contrato Lanza (CNH + Residência → DOCX)

## Caminho do template (canônico)

- Arquivo: `templates/Contrato - Modelo v3.docx` (pasta **`templates`**, com "s").
- Se o usuário citar `template/Contrato - Modelo v3.docx`, trate como o mesmo arquivo acima.

## Entradas esperadas

1. **CNH** do locatário: `.pdf` ou imagem (`.jpg`, `.jpeg`, `.png`, etc.).
2. **Comprovante de residência**: `.pdf` ou imagem.
3. **Opcional** (só se o usuário informar ou houver contexto explícito): veículo/placa, datas de vigência, valores (locação, caução), cláusulas comerciais. O modelo v3 já traz muitos veículos e textos padrão; **não inventar** dados comerciais.

## Extração de dados

1. Abrir e ler os arquivos de CNH e residência (PDF como binário não serve: usar **Read** em imagens exportadas, ou pedir ao usuário **PNG/JPG** das páginas; se for PDF só digitalizado, solicitar imagens ou usar OCR disponível no ambiente).
2. Transcrever com cuidado:
   - **Da CNH**: nome completo (como no documento), CPF, RG (se legível), categoria, número da CNH, validade (se o contrato exigir menção).
   - **Do comprovante**: logradouro, número/complemento, bairro, cidade, UF, CEP.
3. **Normalizar** CPF no padrão `000.000.000-00` e CEP `00000-000` quando possível.
4. Se algum campo essencial estiver ilegível, **parar e pedir** outra foto/arquivo; não preencher com suposição.

## O que o modelo contém (regra de ouro)

O `Contrato - Modelo v3.docx` já inclui o bloco fixo do **LOCADOR** (Lanza) e longos trechos legais e de veículos. O trecho que normalmente muda por cliente é o **primeiro parágrafo do LOCATÁRIO** (nome, CPF, endereço completo) e, no rodapé, **nome do locatário na assinatura** e **data** da cidade.

Texto-alvo do locatário (replicar estilo do modelo; ajustar apenas valores):

`LOCATÁRIO(a): [NOME],inscrito no CPF sob o nº [CPF], residente e domiciliado na [LOGRADOURO COMPLETO], bairro [BAIRRO], cidade [CIDADE], estado [UF], CEP [CEP].`

- Manter vírgulas e a expressão **"inscrito no CPF sob o nº"** como no modelo.
- Unir linhas quebradas do comprovante em uma frase contínua; corrigir abreviações óbvias (Rua, Av., etc.) de forma consistente com o restante do contrato.

Detalhes extras e âncoras de substituição: [reference.md](reference.md).

## Pasta de saída (convenção)

Criar (ou usar) pasta sob **`contratosDir`** em `config/lanza_paths.json` (padrão: `D:\Dropbox\Aluguel Carros`), no formato:

`D:\Dropbox\Aluguel Carros\DD.MM.YYYY - Nome Completo do Locatário\`

(Em máquinas antigas ou cópias locais pode existir legado em `contratos/` na raiz do repositório Aworklanza.)

Dentro dela:

- Cópias ou renomes dos anexos: `CNH.pdf` (ou extensão original), `Residencia.jpg` (ou `.pdf`), conforme os arquivos fornecidos.
- Contrato preenchido: `Contrato - Nome Completo do Locatário.docx` (espelhar o padrão de nome já usado nas pastas de contratos).

Data `DD.MM.YYYY`: usar a data do contrato (pedir ao usuário se não estiver clara; default: data informada pelo usuário ou "hoje" se o usuário autorizar).

## Como produzir o `.docx`

1. **Copiar** o template para o caminho final do contrato (nunca sobrescrever o modelo sem cópia).
2. **Editar** o XML interno ou o documento no Word:
   - Abordagem segura para o agente: **substituir por string** o bloco antigo do locatário de exemplo no `word/document.xml` (após descompactar o `.docx` como ZIP), **somente** se o texto a substituir for idêntico ao trecho extraído do arquivo; caso contrário, localizar o parágrafo entre as âncoras `LOCATÁRIO(a):` e `As partes acima identificadas` descritas em [reference.md](reference.md).
   - Alternativa: orientar abertura no Word e substituição manual se a automação arriscar corromper o arquivo.
3. **Rodapé**: atualizar linha de data (`Tubarão, Santa Catarina, ...`) e o nome abaixo de **LOCATÁRIO** para coincidir com o locatário atual.
4. Abrir o arquivo gerado para conferência rápida (layout, acentos, parágrafos não duplicados).

## Checklist antes de entregar

- [ ] Nome e CPF batem com a CNH.
- [ ] Endereço bate com o comprovante (logradouro, bairro, cidade, UF, CEP).
- [ ] Template original em `templates/` intacto.
- [ ] Pasta do contrato com anexos e `.docx` nomeados de forma consistente.
- [ ] PDF final opcional: só se o usuário pedir (exportar a partir do Word ou ferramenta disponível).

## Privacidade

Tratar CNH, CPF e endereço como **dados sensíveis**. Não colocar esses dados em commits ou tickets públicos sem instrução explícita do usuário.
