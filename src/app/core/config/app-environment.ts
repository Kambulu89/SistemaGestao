import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';
import type { AppEnvironment } from '../../models/environment.model';

/** Acesso injectável ao ambiente actual (facilita substituir em testes). */
export const APP_ENVIRONMENT = new InjectionToken<AppEnvironment>('APP_ENVIRONMENT', {
  providedIn: 'root',
  factory: () => environment,
});
