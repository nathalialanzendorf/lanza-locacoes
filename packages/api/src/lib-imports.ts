/**
 * Ponte única para `src/lib/` — evita espalhar imports relativos nas routes/services.
 * Não altera o código legado; só reexporta o que a API consome.
 */
export {
  loadClientesDb,
  loadClientesDbAsync,
  findClienteInDb,
  findClienteById,
  findClienteByCpf,
  normNomeKey,
  isClienteAtivo,
  isSyncRastreameEligible,
  gravarCliente,
  gravarClienteAsync,
  editarCliente,
  editarClienteAsync,
  excluirCliente,
  excluirClienteAsync,
  type ClienteRegistro,
  type ClientePatch,
} from "../../../src/lib/clientesDb.js";

export type { ClienteImportado } from "../../../src/lib/rastreame/mapMotoristaCliente.js";

export {
  resolveClienteIdListagem,
  resolveVeiculoIdListagem,
  resolveParceiroIdListagem,
  normalizarFiltroVeiculoListagem,
  normalizarFiltroClienteListagem,
  normalizarFiltroParceiroListagem,
  placaDoVeiculoIdListagem,
  isEntityUuid,
  type FiltroVeiculoEntrada,
  type FiltroClienteEntrada,
  type FiltroParceiroEntrada,
} from "../../../src/lib/filtroListagem.js";

export {
  loadVeiculosDb,
  loadVeiculosDbAsync,
  saveVeiculosDb,
  saveVeiculosDbAsync,
  editarVeiculo,
  editarVeiculoAsync,
  excluirVeiculo,
  excluirVeiculoAsync,
  findVeiculoById,
  findVeiculoByPlaca,
  findVeiculoInDb,
  isVeiculoAtivo,
  type VeiculoRegistro,
  type VeiculoPatch,
} from "../../../src/lib/veiculosDb.js";

export {
  loadContratosDb,
  loadContratosDbAsync,
  findContratoInDb,
  contratoAtivoOperacional,
  contratoVinculadoVeiculo,
  contratoMaisRecentePar,
  type ContratoRegistro,
} from "../../../src/lib/contratosDb.js";

export {
  loadClienteDespesasDb,
  loadClienteDespesasDbAsync,
  findClienteDespesaById,
  isClienteDespesaAtiva,
  isClienteDespesaEmAberto,
  isClienteDespesaPaga,
  isClienteDespesaBaixada,
  isLocacaoSemanalEmAberto,
  despesaAtribuidaACliente,
  gravarClienteDespesa,
  editarClienteDespesa,
  excluirClienteDespesa,
  confirmarCondutorClienteDespesa,
  confirmarDebitoParceiroDespesa,
  findClienteDespesaByIdAsync,
  type ClienteDespesaRegistro,
  type ClienteDespesaInput,
  type ClienteDespesaPatch,
} from "../../../src/lib/clienteDespesasDb.js";

export {
  gravarLocacao,
  gravarLocacaoAsync,
  excluirLocacao,
  excluirLocacaoAsync,
  listarLocacoesAsync,
  loadLocacoesDb,
  loadLocacoesDbAsync,
  locacaoEmAberto,
  type LocacaoRegistro,
} from "../../../src/lib/locacoesDb.js";

export type { LocacaoInput } from "../../../src/lib/locacoesDb.js";

export {
  listarVendasAsync,
  obterVendaAsync,
  gravarVendaAsync,
  excluirVendaAsync,
  type VendaRegistro,
  type VendaInput,
  type ListarVendasOpts,
} from "../../../src/lib/vendasDb.js";

export {
  montarPlanoBaixa,
  montarPlanoBaixaAsync,
  withBaixaPlanoDbContext,
  scopeFromLinhasBaixa,
  mergeBaixaExecScope,
  resolverCliente,
  resolvePlacaLinhaPlanoBaixa,
  type MontarPlanoBaixaInput,
  type LinhaPlanoBaixa,
  type PlanoBaixaRecebimento,
} from "../../../src/lib/recebimento/baixaPlano.js";

export {
  gerarSemanal,
  gerarEstacionamento,
  gerarMultas,
  salvarCobranca,
  salvarCobrancasDados,
  COBRANCAS_OUT_DIR,
  type ResultadoCobranca,
} from "../../../src/lib/cobrancas.js";

export {
  executarLoteCobranca,
  listarResumoAlvos,
  salvarLoteConsolidado,
  buildSemanalAtrasoParaEscopo,
  type LoteCobrancaResult,
  type LoteCobrancaItem,
} from "../../../src/lib/cobrancasLote.js";

export {
  TIPOS_COBRANCA_ACTION,
  ROTULO_TIPO_COBRANCA,
  normalizarTipoCobrancaAction,
  listarEscoposContratosAtivosCobranca,
  listarEscoposContratosEncerradosComPendencia,
  resolverModoCanvasCobranca,
  alvoCombinaVeiculoFiltro,
  despesaCombinaVeiculoFiltro,
  type FiltroAlvosCobranca,
  type TipoCobrancaAction,
} from "../../../src/lib/cobrancasAlvos.js";

export {
  montarCobrancaSidecar,
  salvarCobrancasSidecar,
  salvarCobrancaSimplesSidecar,
  salvarRelatorioInfracoesSidecars,
  ehRelatorioInfracoesGlobal,
  type CobrancaRelatorioSidecar,
} from "../../../src/lib/cobrancasRelatorioSidecar.js";

export type { VarianteCanvasInfracoes } from "../../../src/lib/cobrancasRelatorioSidecar.js";

export { gerarCobrancaCanvasDeSidecar } from "../../../src/lib/gerarCobrancaCanvas.js";

export {
  montarRelatorioInfracoesBlocos,
  montarRelatorioInfracoesBlocosAsync,
  type RelatorioInfracoesBlocosDados,
} from "../../../src/lib/relatorioInfracoesBlocos.js";

export {
  calcularEncerramentoContrato,
  calcularEncerramentoContratoAsync,
  formatarEncerramentoTexto,
  formatarEncerramentoWhatsApp,
  type EncerramentoInput,
  type EncerramentoResult,
} from "../../../src/lib/encerrarContrato.js";

export { salvarRelatorioEncerramento } from "../../../src/lib/relatorioEncerramentoArquivo.js";

export {
  montarPacoteCobrancaSemanalAtraso,
  filtrarVencimentosCalculoSemanal,
  jurosMultaDiario,
} from "../../../src/lib/pagamentoSemanalCobranca.js";

export { clienteExibicaoPorId } from "../../../src/lib/clienteExibicao.js";

export {
  PROXIMO_VENCER_DIAS,
  listarContratosVencimentoDashboard,
  type ContratoVencimentoResumo,
} from "../../../src/lib/contratoVencimento.js";

export {
  loadCobrancasDbContextAsync,
  loadCobrancasDbContextForResumoAsync,
  loadCobrancasDbContextSync,
  loadCobrancasScopedDbContextAsync,
  getCobrancasRuntimeCtx,
  setCobrancasRuntimeCtx,
  cobrancasRuntimeDespesas,
  cobrancasRuntimeContratos,
  cobrancasRuntimeVeiculos,
  cobrancasRuntimeClientes,
  type CobrancasDbContext,
} from "../../../src/lib/cobrancasDbContext.js";

export { loadCatalogoEnriquecimentoDespesas } from "../../../src/lib/scopedCatalogo.js";

export { hojeBr, hojeDowBr, nomeDiaSemanaBr, dataStringNoPeriodo, intervaloBrIntersectaPeriodo, type PeriodoBr } from "../../../src/lib/dataBr.js";

export {
  blobKey,
  blobReadWriteToken,
  deleteBlob,
  getBytes,
  getText,
  headBlob,
  isBlobConfigured,
  isStorageActive,
  listBlobs,
  localMirrorRoot,
  mirrorLocalFilesToBlob,
  putBytes,
  putJson,
  putText,
  storagePrefix,
  type ListBlobsResult,
  type MirrorLocalFilesResult,
  type StoredBlob,
} from "../../../packages/storage/src/index.js";

export { compararDataBrAsc } from "../../../src/lib/contratoExtrair.js";

export { dataVencimentoSemanalBr } from "../../../src/lib/pagamentoSemanal.js";
export { vencimentoClienteDespesaBr } from "../../../src/lib/clienteDespesaVencimento.js";
export { formatVeiculoLabel } from "../../../src/lib/veiculoLabel.js";

export { syncMotoristas, replicarClienteNoRastreame } from "../../../src/lib/rastreame/motoristasSync.js";
export { syncRastreaveis, preencherFipeFaltante } from "../../../src/lib/rastreame/rastreaveisSync.js";
export {
  syncRecebimentos,
  pushRecebimentosToRastreame,
} from "../../../src/lib/rastreame/recebimentosSync.js";
export { pushManutencoesToRastreame } from "../../../src/lib/rastreame/manutencaoSync.js";

export {
  sincronizarPedagiosFrota,
  sincronizarPedagiosVeiculo,
  processarPassagensJson,
  processarPassagensJsonLote,
  normalizarTitulosPedagioNoDb,
  normalizarTitulosPedagioNoDbAsync,
  loadPlacasParaSync,
  loadPlacasParaSyncAsync,
  loadAliasesPlacaAsync,
} from "../../../src/lib/pedagioDigital/syncPedagios.js";

export {
  sincronizarEstacionamentoFrota,
  sincronizarEstacionamentoVeiculo,
  processarAvisosJson,
  processarAvisosJsonLote,
  loadPlacasParaSync as loadPlacasParaSyncEstacionamento,
  loadPlacasParaSyncAsync as loadPlacasParaSyncEstacionamentoAsync,
} from "../../../src/lib/sigapay/syncEstacionamento.js";

export {
  clearDetranScRuntimeSession,
  resolveDetranScSession,
} from "../../../src/lib/detranSc/auth.js";

export {
  clearStoredDetranScSession,
  obterStatusDetranScSession,
  saveDetranScSession,
} from "../../../src/lib/detranSc/sessionStore.js";

export {
  getDetranScCaptureState,
  isDetranScCaptureAvailable,
  startDetranScCapture,
  stopDetranScCapture,
} from "../../../src/lib/detranSc/captureCdp.js";

export {
  clearSigapaySession,
} from "../../../src/lib/sigapay/auth.js";

export {
  clearStoredSigapaySession,
  obterStatusSigapaySession,
  saveSigapaySession,
} from "../../../src/lib/sigapay/sessionStore.js";

export {
  getSigapayCaptureState,
  isSigapayCaptureAvailable,
  startSigapayCapture,
  stopSigapayCapture,
} from "../../../src/lib/sigapay/captureCdp.js";

export {
  clearPedagioSession,
} from "../../../src/lib/pedagioDigital/auth.js";

export {
  clearStoredPedagioSession,
  obterStatusPedagioSession,
  savePedagioSession,
} from "../../../src/lib/pedagioDigital/sessionStore.js";

export {
  getPedagioCaptureState,
  isPedagioCaptureAvailable,
  startPedagioCapture,
  stopPedagioCapture,
} from "../../../src/lib/pedagioDigital/captureCdp.js";

export {
  clearDetranRsRuntimeSession,
} from "../../../src/lib/detranRs/auth.js";

export {
  clearStoredDetranRsSession,
  obterStatusDetranRsSession,
  saveDetranRsSession,
} from "../../../src/lib/detranRs/sessionStore.js";

export {
  getDetranRsCaptureState,
  isDetranRsCaptureAvailable,
  startDetranRsCapture,
  stopDetranRsCapture,
} from "../../../src/lib/detranRs/captureCdp.js";

export {
  flattenAlteracoesSync,
  linhaFromParceiroDespesa,
  type SyncAlteracaoLinha,
} from "../../../src/lib/sync/syncAlteracoes.js";

export {
  loadVeiculosParaSync,
  loadVeiculosParaSyncAsync,
  processarRespostaDetranSc,
  sincronizarMultasFrotaDetranSc,
  sincronizarMultasPorTicketDetranSc,
  sincronizarMultasVeiculoDetranSc,
} from "../../../src/lib/detranSc/syncVeiculo.js";

export {
  processarDespesasDetranSc,
  sincronizarDespesasFrotaDetranSc,
  sincronizarDespesasPorTicketDetranSc,
  sincronizarDespesasVeiculoDetranSc,
} from "../../../src/lib/detranSc/syncDespesasVeiculo.js";

export {
  loadVeiculosRsParaSync,
  loadVeiculosRsParaSyncAsync,
  processarRespostaDetranRs,
  sincronizarFrotaDetranRs,
  sincronizarVeiculoDetranRs,
} from "../../../src/lib/detranRs/syncVeiculo.js";

export { ufRegistroDaPlaca } from "../../../src/lib/veiculoUf.js";

export {
  auditarInfracoesSemCondutor,
} from "../../../src/lib/auditarInfracoes.js";

export {
  defaultSeguroAnos,
  defaultSeguroComprovantesDirs,
  extrairSeguroComprovanteBuffer,
  extrairSeguroComprovantesDirs,
  type SeguroBoletoExtraido,
} from "../../../src/lib/extrairSeguroComprovante.js";

export {
  sincronizarParceiroDespesa,
  sincronizarParceiroDespesaAsync,
} from "../../../src/lib/parceiroDespesasDb.js";

export { RELATORIOS_SYNC_DIR, ensureRelatoriosDirs } from "../../../src/lib/relatoriosPaths.js";

export type { DetranRsConsultaVeiculo } from "../../../src/lib/detranRs/consulta.js";

export { REPO_ROOT } from "../../../src/lib/repoRoot.js";

export {
  defaultDocumentosRaiz,
  importarClientesCnh,
  listarPastasComCnh,
  type ImportarCnhResult,
} from "../../../src/lib/importarClientesCnh.js";

export {
  extrairImagemDocumento,
  lerDocumentoUpload,
  parseDocumentoTexto,
  type DocTipoUpload,
  type CnhParseResult,
  type ComprovanteParseResult,
  type CrlvParseResult,
} from "../../../src/lib/documentosParse.js";

export {
  gravarRastreameEspelhoConfig,
  obterRastreameEspelhoConfig,
  rastreameClienteContratoObrigatorio,
  rastreameEspelhoGlobal,
  resolveSyncRastreame,
  type RastreameEspelhoConfig,
} from "../../../src/lib/rastreameEspelhoConfig.js";

export {
  listarMarcas,
  listarModelos,
  listarAnos,
  consultarValor,
  montarUrlFipe,
  resolverFipeVeiculo,
  sincronizarFipeVeiculos,
  consultarPlacaFipeBrasil,
  fipeFieldsFromPlacaFipeBrasil,
  urlPlacaFipeBrasil,
  type FipeSyncProgress,
  type FipeSyncResult,
  type SincronizarFipeOpts,
} from "../../../src/lib/fipe/index.js";

export {
  executarTriagem,
  type FonteId,
} from "../../../src/lib/analiseCadastro/index.js";

export {
  caminhoBase,
  gravarRelatorio,
  montarRelatorio,
  type DadosLgpd,
  type RelatorioTriagem,
} from "../../../src/lib/analiseCadastro/relatorio.js";

export {
  listarTriagens,
  listarTriagensAsync,
  loadTriagemDb,
  loadTriagemDbAsync,
  registrarTriagem,
  registrarTriagemAsync,
  saveTriagemDb,
  saveTriagemDbAsync,
  ultimaTriagemPorCpf,
  ultimaTriagemPorCpfAsync,
  type TriagemRegistro,
} from "../../../src/lib/analiseCadastro/triagemDb.js";

export { registrarAchadosCliente, registrarAchadosClienteAsync } from "../../../src/lib/analiseCadastro/clienteAnaliseDb.js";

export type { DadosLocatario, ResultadoFonte } from "../../../src/lib/analiseCadastro/tipos.js";

export {
  analiseClienteDeRegistro,
  registrarAnaliseCadastroNoCliente,
  registrarAnaliseCadastroNoClienteAsync,
} from "../../../src/lib/clientesDb.js";

export {
  loginRastreame,
  fetchRastreameToken,
} from "../../../src/lib/rastreame/auth.js";

export {
  buildMotoristaPayload,
  findMotorista,
  listMotoristas,
  postMotoristaPayload,
  putMotorista,
  fetchMotoristaByKey,
  type MotoristaRastreame,
} from "../../../src/lib/rastreame/motorista.js";

export {
  fetchGastosList,
  fetchGastoById,
  postGasto,
  putGasto,
} from "../../../src/lib/rastreame/gasto.js";

export {
  loadInfracoesDb,
  loadInfracoesDbAsync,
  findInfracaoByNumeroAuto,
  findInfracaoByNumeroAutoAsync,
  confirmarDebitoParceiroInfracao,
  confirmarDebitoParceiroInfracaoAsync,
  vincularClienteDespesaInfracao,
  vincularClienteDespesaInfracaoAsync,
  type InfracaoRegistro,
} from "../../../src/lib/infracoesDb.js";

export {
  loadParceiroDespesasDb,
  loadParceiroDespesasDbAsync,
  saveParceiroDespesasDb,
  saveParceiroDespesasDbAsync,
  gravarParceiroDespesaManual,
  gravarParceiroDespesaManualAsync,
  marcarBaixaParceiroDespesa,
  marcarBaixaParceiroDespesaAsync,
  type ParceiroDespesaInput,
  type ParceiroDespesaRegistro,
} from "../../../src/lib/parceiroDespesasDb.js";

export {
  registrarContrato,
  registrarContratoAsync,
  registrarContratoFromDadosAsync,
  encerrarContratoDb,
  encerrarContratoDbAsync,
  atualizarContratoDbAsync,
  excluirContrato,
  excluirContratoAsync,
  validarModoContrato,
  validarModoContratoAsync,
  encerrarContratoAtivoParaRenovarAsync,
  type MotivoEncerramento,
  type AtualizarContratoDbPatch,
} from "../../../src/lib/contratosDb.js";

export {
  ativarClienteDoContrato,
  desativarClienteDoContrato,
} from "../../../src/lib/contratoClienteStatus.js";

export {
  gerarDespesasIniciaisContratoAsync,
  contratoTemParcelamento,
  type DespesasIniciaisContratoResult,
} from "../../../src/lib/contratoDespesasIniciais.js";

export {
  resolverPastaContratoFromDados,
  resolverNomeArquivoContrato,
  nomeArquivoContratoComExtensao,
  gerar,
  type GerarContratoDados,
} from "../../../src/lib/docxGerar.js";

export {
  ensurePdfFromDocx,
} from "../../../src/lib/exportDocxToPdf.js";

export {
  montarDadosContratoFromDb,
  montarDadosContratoFromDbAsync,
  dadosParaContratoExtraido,
  type MontarContratoDbInput,
} from "../../../src/lib/montarDadosContrato.js";

export {
  montarPrestacaoContas,
  type PrestacaoContasInput,
  type PrestacaoContasResult,
} from "../../../src/cli/montarRelatorio.js";

export {
  dataPagamentoParaIso,
  executarRenegociacao,
  extrairCodigoNegociado,
  infoMarcadaNegociada,
  infoParcelaRenegociacao,
  listarCodigosNegociacaoMotorista,
  listarDebitosAbertos,
  proximoCodigoNegociado,
  rastreavelKeyFromGasto,
  somarDebitos,
  validarParcelas,
  type RenegociacaoInput,
  type ParcelaRenegociacao,
  type ResumoDebito,
} from "../../../src/lib/rastreame/renegociacao.js";

export { formatPlacaHyphen, placasIguais, compactPlaca } from "../../../src/lib/placa.js";

export {
  readLanzaPaths,
  defaultContratosDir,
  prestacaoContasBaseDir,
} from "../../../src/lib/lanzaPaths.js";

export {
  listarLocacoes,
  sugerirLocacoes,
  type SugerirOpts,
  type SugestaoLocacoes,
} from "../../../src/lib/locacoesDb.js";

export {
  CATEGORIA_PEDAGIO,
  ROTULO_PEDAGIO_DIGITAL,
  CATEGORIA_PEDAGIO_DIGITAL,
  CATEGORIA_PEDAGIO_LEGADO,
  isCategoriaPedagio,
} from "../../../src/lib/pedagioCategoria.js";

export {
  CATEGORIA_ESTACIONAMENTO,
  ROTULO_SIGAPAY,
  ROTULO_ESTACIONAMENTO_SIGAPAY,
  CATEGORIA_ESTACIONAMENTO_ROTATIVO,
  CATEGORIA_ESTACIONAMENTO_LEGADO,
  isCategoriaEstacionamento,
} from "../../../src/lib/estacionamentoCategoria.js";

export {
  espelharInfracaoParceiro,
  espelharInfracaoParceiroAsync,
  espelharClienteDespesaSemLocatarioAsync,
  reconciliarEspelhosParceiro,
  reconciliarEspelhosParceiroAsync,
} from "../../../src/lib/espelharSemLocatarioParceiro.js";

export {
  infracaoResponsavelConfirmado,
  despesaResponsavelConfirmado,
} from "../../../src/lib/responsavelDebito.js";

export {
  reconciliarCondutores,
  confirmarClienteInfracao,
  type ReconResult,
} from "../../../src/lib/atribuirCondutores.js";

export {
  listarClienteAnalise,
  type RegistroClienteAnalise,
} from "../../../src/lib/analiseCadastro/clienteAnaliseDb.js";

export {
  importarClientesRastreame,
  type ImportarClientesResult,
} from "../../../src/lib/importarClientesRastreame.js";

export {
  lancarRastreadorFixo,
  lancarRastreadorFixoAsync,
  competenciaAtual,
  RASTREADOR_VALOR_PADRAO,
  RASTREADOR_DIA_PADRAO,
} from "../../../src/lib/rastreadorFixo.js";

export {
  derivarInicioLocacoes,
  derivarInicioLocacoesAsync,
  gravarInicioLocacoesDerivado,
  gravarInicioLocacoesDerivadoAsync,
} from "../../../src/lib/inicioLocacoes.js";

export {
  checkPagBankAuth,
  pagBankAuthConfigured,
} from "../../../src/lib/pagbank/auth.js";

export {
  fetchAllCreditosPagBank,
  fetchCreditosPagBank,
  defaultDateRange,
} from "../../../src/lib/pagbank/statements.js";

export {
  montarLotePagBank,
  type LotePagBankResult,
} from "../../../src/lib/pagbank/matchLote.js";

export {
  registrarPlaca,
  excluirPlacaPorPlaca,
  listarVeiculos as listarVeiculosPedagio,
} from "../../../src/lib/pedagioDigital/veiculos.js";

export {
  listarPassagens,
  listarPassagensLote,
  type PassagemPedagio,
  type PassagemStatus,
} from "../../../src/lib/pedagioDigital/passagens.js";

export {
  listarAvisos,
  listarAvisosLote,
  type AvisoStatus,
} from "../../../src/lib/sigapay/avisos.js";

export {
  solicitarCodigoPixRegularizacao,
  verificarCodigoPixRegularizacao,
  type PixRegularizacaoSolicitarResult,
  type PixRegularizacaoVerificarResult,
} from "../../../src/lib/sigapay/pixRegularizacao.js";

export {
  listarVeiculosSigapay,
  registrarPlacaSigapay,
  excluirPlacaSigapayPorPlaca,
} from "../../../src/lib/sigapay/veiculos.js";

export {
  sincronizarVeiculosCrlv,
  type SincronizarVeiculosCrlvOpts,
  type SincronizarVeiculosCrlvResult,
} from "../../../src/cli/sincronizarVeiculosCrlv.js";

export {
  importarContratos,
  type ImportarContratosOpts,
  type ImportarContratosResult,
} from "../../../src/cli/importarContratos.js";

export {
  lancarSemanalRastreame,
  type LancarSemanalRastreameOpts,
  type LancarSemanalRastreameResult,
} from "../../../src/cli/rastreameLancarSemanal.js";

export {
  cepDigitos,
  cepValido,
  consultarViaCep,
  formatarCep,
  type ViaCepResult,
} from "../../../src/lib/viaCep.js";
