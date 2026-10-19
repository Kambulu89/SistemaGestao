import type { AppEnvironment } from '../app/core/config/environment.model';

export const environment: AppEnvironment = {
  production: false,
  name: 'development',
  appName: 'Plataforma de Gestão',
  apiUrl: 'http://localhost:3000/api',
  defaultLocale: 'pt-PT',
  defaultCurrency: 'EUR',
  defaultTimeZone: 'Europe/Lisbon',
};
