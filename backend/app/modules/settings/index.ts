/** API pública das configurações e dados de referência (contratos para os módulos de negócio). */
export { tenantSettings } from '#modules/settings/application/company_service'
export {
  onBankAccountDecided,
  rateOn,
  reserveDocumentNumber,
  workingDaysBetween,
} from '#modules/settings/application/reference_service'
export { type TenantSettings } from '#modules/settings/domain/settings'
export { isValidIban } from '#modules/settings/domain/banking'
