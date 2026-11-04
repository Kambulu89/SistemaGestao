import type { BaseCommand } from '@adonisjs/core/ace'
import { ApiError } from '#shared/http/api_error'

/** Mostra erros de validação/conflito de forma legível num comando ace (sem stack) e termina com código 1. */
export function reportCommandError(command: BaseCommand, error: unknown) {
  if (!(error instanceof ApiError)) throw error
  command.logger.error(`${error.code}: ${error.message}`)
  for (const detail of error.details) command.logger.error(`  ${detail.path}: ${detail.message}`)
  command.exitCode = 1
}
