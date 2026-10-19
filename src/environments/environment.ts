import type { AppEnvironment } from '../app/core/config/environment.model';

export const environment: AppEnvironment = {
  production: true,
  name: 'production',
  appName: 'Plataforma de Gestão',
  apiUrl: 'https://api.example.com/api',
  defaultLocale: 'pt-PT',
  defaultCurrency: 'EUR',
  defaultTimeZone: 'Europe/Lisbon',
};
