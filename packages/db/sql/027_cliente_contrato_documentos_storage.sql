-- Documentos de cliente (CNH, comprovante) e contrato gerado no Blob.

ALTER TABLE lanza.clientes
  ADD COLUMN IF NOT EXISTS cnh_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS cnh_documento_nome TEXT,
  ADD COLUMN IF NOT EXISTS comprovante_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS comprovante_documento_nome TEXT;

COMMENT ON COLUMN lanza.clientes.cnh_storage_key IS 'Vercel Blob pathname da CNH enviada pelo cadastro web.';
COMMENT ON COLUMN lanza.clientes.cnh_documento_nome IS 'Nome original do ficheiro da CNH.';
COMMENT ON COLUMN lanza.clientes.comprovante_storage_key IS 'Vercel Blob pathname do comprovante de residência.';
COMMENT ON COLUMN lanza.clientes.comprovante_documento_nome IS 'Nome original do comprovante de residência.';

ALTER TABLE lanza.contratos
  ADD COLUMN IF NOT EXISTS documento_docx_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS documento_pdf_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS documento_gerado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS documento_gerado_nome TEXT;

COMMENT ON COLUMN lanza.contratos.documento_docx_storage_key IS 'Última versão Word gerada (Blob).';
COMMENT ON COLUMN lanza.contratos.documento_pdf_storage_key IS 'Última versão PDF gerada (Blob).';
COMMENT ON COLUMN lanza.contratos.documento_gerado_em IS 'Quando a última versão Word/PDF foi gerada.';
COMMENT ON COLUMN lanza.contratos.documento_gerado_nome IS 'Nome base do ficheiro gerado (sem extensão).';
