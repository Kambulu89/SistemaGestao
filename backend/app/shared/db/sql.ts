/** SQLSTATE de violação de unicidade, usado pelos repositórios para converter duplicados em 409. */
export const UNIQUE_VIOLATION = '23505'

/** SQLSTATE de violação de uma restrição de exclusão (p. ex. intervalos de datas sobrepostos). */
export const EXCLUSION_VIOLATION = '23P01'

export const constraintOf = (error: unknown): string | undefined => {
  const code = (error as { code?: string } | null)?.code
  return code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION
    ? (error as { constraint?: string }).constraint
    : undefined
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
