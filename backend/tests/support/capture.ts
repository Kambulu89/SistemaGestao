/** Executa `fn` e devolve o erro lançado; falha se não lançar nada. */
export async function capture(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('Era esperado um erro e a operação foi bem-sucedida.')
}
