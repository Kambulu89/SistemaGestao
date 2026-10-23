import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Causalidade dos eventos: um evento escrito enquanto uma automação executa leva a execução e a profundidade, por isso
 * quem o consome sabe que veio de uma automação e a que distância (ciclos A→B→A param no limite de profundidade).
 * Usa o contexto assíncrono: as acções não precisam de conhecer a automação que as chamou.
 */
export interface Causation {
  runId: string
  depth: number
}

const storage = new AsyncLocalStorage<Causation>()

export const runWithCausation = <T>(causation: Causation, fn: () => Promise<T>): Promise<T> =>
  storage.run(causation, fn)

export const currentCausation = (): Causation | undefined => storage.getStore()
