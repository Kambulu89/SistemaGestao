import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { mockSettings } from '../mock/mock-helpers';
import { MOCK_PASSWORD } from '../mock/mock-data';
import { provideMockBackend } from '../mock/provide-mock-backend';
import { AuthGateway } from '../auth/auth.gateway';
import { TenantGateway } from '../tenant-context/tenant.gateway';
import { MockAuthGateway } from './mock-auth.gateway';
import { MockTenantGateway } from './mock-tenant.gateway';
import { provideRouter } from '@angular/router';
import { ALL_MODULE_MANIFESTS } from '../../module-catalog';
import { MODULE_MANIFESTS } from '../modules/module-manifests.token';

/** Configura o TestBed com duplos de teste (identidade, tenants) e os mocks do core dinâmico, sem latência. */
export function setupMockBackend(): void {
  mockSettings.latencyMs = 0;
  sessionStorage.clear();
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: MODULE_MANIFESTS, useValue: ALL_MODULE_MANIFESTS },
      { provide: AuthGateway, useClass: MockAuthGateway },
      { provide: TenantGateway, useClass: MockTenantGateway },
      provideMockBackend(),
    ],
  });
}

export async function loginAs(email: string): Promise<void> {
  await firstValueFrom(TestBed.inject(AuthService).login({ email, password: MOCK_PASSWORD }));
}
