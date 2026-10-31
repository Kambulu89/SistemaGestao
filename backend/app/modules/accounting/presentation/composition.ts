import { LucidTenantDatabase } from '#core/tenancy/index'
import {
  ChartUseCases,
  EntryUseCases,
  FiscalYearUseCases,
  JournalUseCases,
  PostingRuleUseCases,
  PostingService,
} from '#modules/accounting/application/accounting_use_cases'
import { LucidAccountingStore } from '#modules/accounting/infrastructure/lucid_accounting'

function build() {
  const uow = new LucidTenantDatabase()
  const clock = { now: () => new Date() }
  const store = new LucidAccountingStore()
  const chart = new ChartUseCases(uow, store)
  const entries = new EntryUseCases(uow, store, chart, clock)
  return {
    chart,
    fiscalYears: new FiscalYearUseCases(uow, store, chart),
    journals: new JournalUseCases(uow, store, chart),
    entries,
    rules: new PostingRuleUseCases(uow, store, chart),
    posting: new PostingService(uow, store, entries),
  }
}

let instance: ReturnType<typeof build> | undefined

export const accountingServices = () => (instance ??= build())
