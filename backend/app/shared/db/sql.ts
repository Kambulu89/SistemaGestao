/** SQLSTATE de violação de unicidade, usado pelos repositórios para converter duplicados em 409. */
export const UNIQUE_VIOLATION = '23505'

export const constraintOf = (error: unknown): string | undefined =>
  (error as { code?: string; constraint?: string } | null)?.code === UNIQUE_VIOLATION
    ? (error as { constraint?: string }).constraint
    : undefined

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
