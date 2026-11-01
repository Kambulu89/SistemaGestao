/** Erro normalizado devolvido pelo `errorInterceptor` para qualquer falha HTTP. */
export interface ApiError {
  /** Código HTTP; `0` quando não houve resposta (rede, CORS, timeout). */
  readonly status: number;
  readonly message: string;
  /** Código estável da API (ex.: `LAST_ADMIN`, `VERSION_CONFLICT`); ausente se não houve resposta. */
  readonly code?: string;
  /** Erros por campo da API (`path` completo, ex.: `contacts[0].value`). */
  readonly fieldErrors?: readonly ApiErrorDetail[];
  /** Carga estruturada própria de quem lançou o erro (ex.: falhas de validação dos adaptadores locais). */
  readonly details?: unknown;
  /** Para o utilizador poder indicar ao suporte; também está nos logs do servidor. */
  readonly correlationId?: string;
  /** Segundos até poder repetir (cabeçalho `Retry-After` do 429). */
  readonly retryAfterSeconds?: number;
}

export interface ApiErrorDetail {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
