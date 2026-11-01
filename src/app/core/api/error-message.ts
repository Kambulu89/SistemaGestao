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

/**
 * Como `errorMessage`, mas um erro de validação diz **que campo** falhou: junta as mensagens por campo do servidor
 * («Verifique os campos indicados.» sozinho não ajuda a corrigir nada).
 */
export function detailedErrorMessage(error: unknown, fallback = FALLBACK): string {
  const source = error instanceof Error && hasMessage(error.cause) ? error.cause : error;
  const fields = (source as { fieldErrors?: readonly { message?: unknown }[] } | null)?.fieldErrors;
  const messages = (fields ?? [])
    .map((f) => f.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  return messages.length > 0 ? messages.join(' ') : errorMessage(error, fallback);
}
