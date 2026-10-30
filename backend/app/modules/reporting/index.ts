/** API pública dos relatórios e da pesquisa (S04). Outros módulos importam **apenas** daqui. */
export { reportingServices } from '#modules/reporting/presentation/composition'
export { registerDataset, registerSearchSource } from '#modules/reporting/application/registry'
export { registerReporting } from '#modules/reporting/presentation/registration'
export type { SearchSource, SearchItem } from '#modules/reporting/application/ports'
export type { DatasetDefinition, DatasetField } from '#modules/reporting/domain/reporting'
