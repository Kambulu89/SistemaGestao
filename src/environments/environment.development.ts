import type { AppEnvironment } from '../app/core/config/environment.model';

export const environment: AppEnvironment = {
  production: false,
  name: 'development',
  appName: 'Plataforma de Gestão',
  apiUrl: 'http://localhost:3333/api/v1',
  defaultLocale: 'pt-AO',
  defaultCurrency: 'AOA',
  defaultTimeZone: 'Africa/Luanda',
};
