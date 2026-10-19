import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import localePt from '@angular/common/locales/pt-PT';
import {
  type ApplicationConfig,
  inject,
  LOCALE_ID,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideRouter,
  TitleStrategy,
  withComponentInputBinding,
  withInMemoryScrolling,
} from '@angular/router';
import { routes } from './app.routes';
import { PageTitleStrategy } from './core/config/page-title.strategy';
import { ThemeService } from './core/config/theme.service';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { MODULE_MANIFESTS } from './core/modules/module-manifests.token';
import { provideMockBackend } from './core/mock/provide-mock-backend';
import { ALL_MODULE_MANIFESTS } from './module-catalog';

registerLocaleData(localePt);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, errorInterceptor])),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
    { provide: LOCALE_ID, useValue: 'pt-PT' },
    // Enquanto não houver backend, os contratos do core são servidos por adapters mock.
    { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
    provideMockBackend(),
    // Instancia o tema no arranque para aplicar a classe `dark` de imediato.
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
  ],
};
