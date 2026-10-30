import type { DatasetDefinition } from '#modules/reporting/domain/reporting'
import type { SearchSource } from '#modules/reporting/application/ports'

/**
 * Datasets e origens de pesquisa registados em código. Um tenant não define SQL nem datasets: só escolhe, entre os
 * campos permitidos, o que ver, filtrar, agrupar e medir.
 */
const datasets = new Map<string, DatasetDefinition>()
const sources = new Map<string, SearchSource>()

export function registerDataset(dataset: DatasetDefinition): void {
  datasets.set(dataset.code, dataset)
}

export function registerSearchSource(source: SearchSource): void {
  sources.set(source.type, source)
}

export const datasetOf = (code: string): DatasetDefinition | undefined => datasets.get(code)
export const allDatasets = (): DatasetDefinition[] => [...datasets.values()]
export const searchSourceOf = (type: string): SearchSource | undefined => sources.get(type)
export const allSearchSources = (): SearchSource[] => [...sources.values()]
