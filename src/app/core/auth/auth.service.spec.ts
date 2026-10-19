import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { setupMockBackend } from '../testing/test-backend';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  beforeEach(() => setupMockBackend());

  it('starts anonymous', () => {
    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
  });

  it('logs in, exposes the user and persists the session', async () => {
    const auth = TestBed.inject(AuthService);
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    expect(auth.user()?.name).toBe('Rui Multi-tenant');
    expect(sessionStorage.getItem('sg-session')).toContain('multi@demo.pt');
  });

  it('rejects wrong credentials without creating a session', async () => {
    const auth = TestBed.inject(AuthService);
    await expect(
      firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'x' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('logs out and clears storage', async () => {
    const auth = TestBed.inject(AuthService);
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
    expect(sessionStorage.getItem('sg-session')).toBeNull();
  });

  it('ignores an expired stored session', () => {
    sessionStorage.setItem(
      'sg-session',
      JSON.stringify({ user: {}, accessToken: 't', expiresAt: new Date(0).toISOString() }),
    );
    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
  });
});
