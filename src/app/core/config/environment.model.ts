export interface AppEnvironment {
  readonly production: boolean;
  readonly name: string;
  readonly appName: string;
  /** URL base da API REST, sem barra final. */
  readonly apiUrl: string;
  /** Valores por omissão da plataforma; cada tenant pode sobrepor-se (ver AppConfigService). */
  readonly defaultLocale: string;
  readonly defaultCurrency: string;
  readonly defaultTimeZone: string;
}
