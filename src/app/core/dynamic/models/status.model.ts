export type SemanticColor = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export interface StatusDefinition {
  readonly id: string;
  /** Código técnico estável, guardado nos registos (ex.: `available`). */
  readonly code: string;
  readonly name: string;
  readonly color: SemanticColor;
  readonly icon?: string;
  readonly description?: string;
  /** Estado atribuído a um registo novo (quando não há workflow). */
  readonly initial?: boolean;
  /** Estado terminal. */
  readonly final?: boolean;
  readonly order: number;
}
