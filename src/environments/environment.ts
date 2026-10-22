import type { AppEnvironment } from '../app/core/config/environment.model';

export const environment: AppEnvironment = {
  production: true,
  name: 'production',
  appName: 'Plataforma de Gestão',
  apiUrl: '/api/v1',
  defaultLocale: 'pt-AO',
  defaultCurrency: 'AOA',
  defaultTimeZone: 'Africa/Luanda',
};
