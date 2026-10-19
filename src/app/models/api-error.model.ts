/** Erro normalizado devolvido pelo `errorInterceptor` para qualquer falha HTTP. */
export interface ApiError {
  /** Código HTTP; `0` quando não houve resposta (rede, CORS, timeout). */
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}
