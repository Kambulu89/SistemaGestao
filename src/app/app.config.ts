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
import { firstValueFrom } from 'rxjs';
import { AuthGateway } from './core/auth/auth.gateway';
import { AuthService } from './core/auth/auth.service';
import { HttpAuthGateway } from './core/auth/http-auth.gateway';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { tenantScopeInterceptor } from './core/interceptors/tenant-scope.interceptor';
import { TenantGateway } from './core/tenant-context/tenant.gateway';
import { HttpTenantGateway } from './core/tenant-context/http-tenant.gateway';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { MODULE_MANIFESTS } from './core/modules/module-manifests.token';
import { provideDynamicBackend } from './core/dynamic/http/provide-dynamic-backend';
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
    provideHttpClient(
      withFetch(),
      withInterceptors([authInterceptor, tenantScopeInterceptor, errorInterceptor]),
    ),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
    { provide: LOCALE_ID, useValue: 'pt-PT' },
    { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
    // Identidade e tenants são HTTP (backend real, sessão em cookie).
    { provide: AuthGateway, useClass: HttpAuthGateway },
    { provide: TenantGateway, useClass: HttpTenantGateway },
    // Entidades dinâmicas e registos (C10) também são HTTP; campos personalizados ainda sem servidor.
    provideDynamicBackend(),
    // Recupera a sessão do cookie antes da primeira navegação (os guards já a encontram).
    provideAppInitializer(() => firstValueFrom(inject(AuthService).restore()).catch(() => null)),
    // Instancia o tema no arranque para aplicar a classe `dark` de imediato.
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
  ],
};
