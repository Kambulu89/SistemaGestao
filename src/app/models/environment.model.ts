export interface AppEnvironment {
  readonly production: boolean;
  readonly name: string;
  /** URL base da API REST, sem barra final. */
  readonly apiUrl: string;
}
