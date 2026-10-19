import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { mockSettings } from '../mock/mock-helpers';
import { MOCK_PASSWORD } from '../mock/mock-data';
import { provideMockBackend } from '../mock/provide-mock-backend';
import { provideRouter } from '@angular/router';

/** Configura o TestBed com os adapters mock sem latência. */
export function setupMockBackend(): void {
  mockSettings.latencyMs = 0;
  sessionStorage.clear();
  localStorage.clear();
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideMockBackend()] });
}

export async function loginAs(email: string): Promise<void> {
  await firstValueFrom(TestBed.inject(AuthService).login({ email, password: MOCK_PASSWORD }));
}
