import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { setupMockBackend } from '../testing/test-backend';
import { AuthGateway } from './auth.gateway';
import type { Session } from './auth.model';
import { AuthService } from './auth.service';

const SESSION: Session = {
  user: { id: 'u1', name: 'Ana', email: 'ana@exemplo.pt', platformPermissions: [] },
  csrfToken: 'csrf-1',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe('AuthService', () => {
  beforeEach(() => setupMockBackend());

  it('starts anonymous', () => {
    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
  });

  it('logs in and keeps the session in memory only (nothing in browser storage)', async () => {
    const auth = TestBed.inject(AuthService);
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    expect(auth.user()?.name).toBe('Rui Multi-tenant');
    expect(auth.csrfToken()).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('rejects wrong credentials without creating a session', async () => {
    const auth = TestBed.inject(AuthService);
    await expect(
      firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'x' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('logs out locally and asks the server to revoke the session', async () => {
    const auth = TestBed.inject(AuthService);
    const gateway = TestBed.inject(AuthGateway);
    const revoke = vi.spyOn(gateway, 'logout');
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('sends the logout request before clearing the CSRF token', async () => {
    const auth = TestBed.inject(AuthService);
    const gateway = TestBed.inject(AuthGateway);
    let csrfAtRequest: string | null = null;
    vi.spyOn(gateway, 'logout').mockImplementation(() => {
      csrfAtRequest = auth.csrfToken();
      return of(undefined);
    });
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    auth.logout();
    expect(csrfAtRequest).toBeTruthy();
  });

  it('expireLocally clears the state without another server call', async () => {
    const auth = TestBed.inject(AuthService);
    const revoke = vi.spyOn(TestBed.inject(AuthGateway), 'logout');
    await firstValueFrom(auth.login({ email: 'multi@demo.pt', password: 'demo1234' }));
    auth.expireLocally();
    expect(auth.isAuthenticated()).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('restores the session from the server (cookie) on startup', async () => {
    const auth = TestBed.inject(AuthService);
    vi.spyOn(TestBed.inject(AuthGateway), 'restore').mockReturnValue(of(SESSION));
    await firstValueFrom(auth.restore());
    expect(auth.user()?.email).toBe('ana@exemplo.pt');
    expect(auth.csrfToken()).toBe('csrf-1');
  });

  it('stays anonymous when there is no session to restore', async () => {
    const auth = TestBed.inject(AuthService);
    await firstValueFrom(auth.restore());
    expect(auth.isAuthenticated()).toBe(false);
  });
});
