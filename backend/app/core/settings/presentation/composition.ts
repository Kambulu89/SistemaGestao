import { LucidTenantDatabase } from '#core/tenancy/index'
import {
  ListSettings,
  ResetSetting,
  ResolveSettings,
  SequenceIssuer,
  SequenceUseCases,
  SetSetting,
  TaxRateUseCases,
  UnitUseCases,
} from '#core/settings/application/use_cases'
import {
  LucidReferenceLookup,
  LucidSequenceStore,
  LucidSettingStore,
  LucidTaxRateStore,
  LucidUnitStore,
} from '#core/settings/infrastructure/lucid_settings'

function build() {
  const uow = new LucidTenantDatabase()
  const lookup = new LucidReferenceLookup()
  const settings = new LucidSettingStore()
  const sequences = new LucidSequenceStore()
  return {
    resolveSettings: new ResolveSettings(uow, settings, lookup),
    listSettings: new ListSettings(uow, settings, lookup),
    setSetting: new SetSetting(uow, settings, lookup),
    resetSetting: new ResetSetting(uow, settings, lookup),
    taxRates: new TaxRateUseCases(uow, new LucidTaxRateStore(), lookup),
    units: new UnitUseCases(uow, new LucidUnitStore()),
    sequences: new SequenceUseCases(uow, sequences, lookup),
    /** Para os módulos que emitem documentos: corre dentro da transacção do documento. */
    sequenceIssuer: new SequenceIssuer(sequences, lookup),
  }
}

let instance: ReturnType<typeof build> | undefined

export const settingsServices = () => (instance ??= build())
