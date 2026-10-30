/** Violação de uma regra de C09; a camada de aplicação converte-a em erro de validação (422). */
export class SettingsRuleError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
