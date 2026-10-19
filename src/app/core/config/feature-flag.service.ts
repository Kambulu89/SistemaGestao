import { inject, Injectable } from '@angular/core';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/** Feature flags do tenant activo. Flag desconhecida = desligada. */
@Injectable({ providedIn: 'root' })
export class FeatureFlagService {
  private readonly tenantContext = inject(TenantContextService);

  isEnabled(flag: string): boolean {
    return this.tenantContext.active()?.featureFlags[flag] ?? false;
  }
}
