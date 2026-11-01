/** API pública das finanças (M09): composição dos serviços e ligação aos módulos de venda e facturação. */
export { financeServices } from '#modules/finance/presentation/composition'
export { registerFinance } from '#modules/finance/presentation/registration'
export type {
  Obligation,
  Payment,
  SupplierInvoice,
  TreasuryAccount,
} from '#modules/finance/application/ports'
