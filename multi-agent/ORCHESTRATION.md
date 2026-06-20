# Orquestração — fluxo e contrato entre agentes

## Ordem fixa

```
Extrator (1) → Montador (2) → Revisor (3) → [humano ou script: editar DOCX]
```

Não paralelizar 1 e 2: o montador **depende** do JSON do extrator. O revisor pode receber (JSON + markdown do montador) em um único prompt.

## Schema JSON (saída do agente 1 — Extrator)

O extrator deve responder **somente** com um JSON válido neste formato (campos desconhecidos = `null`, sem comentários):

```json
{
  "nome_completo_cnh": "",
  "cpf": "",
  "rg": null,
  "categoria_cnh": null,
  "numero_registro_cnh": null,
  "validade_cnh": null,
  "logradouro": "",
  "numero_complemento": "",
  "bairro": "",
  "cidade": "",
  "uf": "",
  "cep": "",
  "fontes": {
    "cnh_path": "",
    "residencia_path": ""
  },
  "avisos_legibilidade": []
}
```

## Saída do agente 2 — Montador

- Parágrafo único no formato do modelo: `LOCATÁRIO(a): ...` (ver `.cursor/skills/contrato/SKILL.md`).
- Nome por extenso para rodapé (igual ao da CNH).
- Sugestão de pasta: `D:\Dropbox\Aluguel Carros\DD.MM.YYYY - Nome Completo\` (ver `config/lanza_paths.json` no repo Aworklanza).
- Não alterar cláusulas de veículos/valores salvo instrução explícita.

## Saída do agente 3 — Revisor

- Tabela ou lista: campo | status (ok/atenção) | observação.
- Se houver **atenção** em CPF, nome ou CEP, o fluxo **para** para correção humana ou novo ciclo só no extrator com arquivos melhores.

## Falhas

- Se o JSON do extrator for inválido: **não** chamar o montador; repetir extrator com “corrija para JSON estrito”.
- Se o revisor falhar algo crítico: não prosseguir para publicar/commit do contrato preenchido.
