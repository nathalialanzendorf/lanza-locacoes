-- Versão sequencial do documento Word/PDF gerado (1, 2, 3 … por contrato).

ALTER TABLE lanza.contratos
  ADD COLUMN IF NOT EXISTS documento_gerado_versao INTEGER;

COMMENT ON COLUMN lanza.contratos.documento_gerado_versao IS
  'Número da última versão Word/PDF gerada para este contrato (1, 2, 3 …).';

UPDATE lanza.contratos
SET documento_gerado_versao = 1
WHERE documento_gerado_em IS NOT NULL
  AND documento_gerado_versao IS NULL;
