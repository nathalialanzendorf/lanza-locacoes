# Referência — Modelo v3 e âncoras de texto

## Estrutura observada no modelo

O corpo começa com o título, em seguida o bloco do **LOCADOR** (texto fixo Lanza até o CEP da empresa), imediatamente seguido do bloco do **LOCATÁRIO** em um mesmo fluxo narrativo.

O bloco do locatário no arquivo extraído costuma iniciar com:

`LOCATÁRIO(a):`

e terminar logo antes de:

`As partes acima identificadas têm, entre si, justo e acertado`

Tudo entre essas duas âncoras deve ser reescrito com os dados do novo cliente, **preservando** o prefixo `LOCATÁRIO(a): ` e o sufixo que inicia com `As partes acima...` (incluindo o ponto final do endereço imediatamente antes de "As partes").

## Exemplo de formato (ilustrativo)

```
LOCATÁRIO(a): MARIA SILVA SANTOS,inscrito no CPF sob o nº 123.456.789-00, residente e domiciliado na Rua das Flores, 100, Apto 201, bairro Centro, cidade Tubarão, estado Santa Catarina, CEP 88705-000.
```

Observações:

- O modelo usa **"inscrito no"** também para pessoa física; manter para não divergir do documento já usado em produção.
- Sem espaço após a vírgula do nome em alguns exemplos do modelo (`NOME,inscrito`); seguir o padrão já presente no arquivo copiado se estiver inconsistente.

## Rodapé e assinaturas

No final do documento há linhas de assinatura com rótulos **LOCATÁRIO** / **LOCADOR** e nomes por extenso. Substituir o nome do locatário de exemplo pelo nome completo extraído da CNH.

A linha de local e data segue o padrão com "Tubarão, Santa Catarina," e data por extenso; atualizar mês e ano conforme a data acordada do contrato.

## Cláusula 1 (veículos) e valores

O v3 contém **vários** parágrafos "1.1" com veículos diferentes. Só alterar essa seção se o usuário pedir ajuste de frota ou se houver lista oficial fornecida. Caso contrário, limitar a edição ao **identificação do locatário** e **data/assinatura**.

## Arquivos auxiliares no repositório

Se existir `database/clientes.json` ou equivalente, pode ser usado para cruzar placa ou cliente **somente** se o usuário pedir integração; não é obrigatório para este fluxo.
