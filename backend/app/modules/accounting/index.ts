/** API pública da contabilidade geral (ERP E1, D-062). Outros módulos importam **apenas** daqui. */
export { accountingServices } from '#modules/accounting/presentation/composition'
export {
  PostingRuleMissing,
  type PostingRequest,
} from '#modules/accounting/application/accounting_use_cases'
export { POSTING_EVENTS } from '#modules/accounting/domain/accounting'
