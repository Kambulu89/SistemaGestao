import { computed, inject, Injectable } from '@angular/core';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { APP_ENVIRONMENT } from './app-environment';

/** Configuração efectiva: valores da plataforma, sobrepostos pelas preferências do tenant activo. */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  private readonly env = inject(APP_ENVIRONMENT);
  private readonly tenant = inject(TenantContextService).tenant;

  readonly appName = this.env.appName;
  readonly locale = computed(() => this.tenant()?.locale ?? this.env.defaultLocale);
  readonly currency = computed(() => this.tenant()?.currency ?? this.env.defaultCurrency);
  readonly timeZone = computed(() => this.tenant()?.timeZone ?? this.env.defaultTimeZone);
}
