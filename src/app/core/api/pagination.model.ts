export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

/** Pedido de listagem. Página começa em 1. */
export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: SortState;
  /** Filtros simples chave/valor; filtros complexos serão definidos com o contrato do backend. */
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
