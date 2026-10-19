const FALLBACK = 'Ocorreu um erro inesperado. Tente novamente.';

const hasMessage = (value: unknown): value is { message: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { message?: unknown }).message === 'string';

/**
 * Mensagem apresentável de um erro. O `rxResource` do Angular embrulha em `Error` os erros que
 * não são `Error` (como o nosso `ApiError`) e guarda o original em `cause`: é esse que interessa.
 */
export function errorMessage(error: unknown, fallback = FALLBACK): string {
  if (error instanceof Error && hasMessage(error.cause)) return error.cause.message;
  if (hasMessage(error)) return error.message;
  return fallback;
}
