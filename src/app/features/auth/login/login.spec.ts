import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { throwError } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { AuthService } from '../../../core/auth/auth.service';
import { setupMockBackend } from '../../../core/testing/test-backend';
import { Login } from './login';

describe('Login', () => {
  let login: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupMockBackend();
    login = vi.spyOn(TestBed.inject(AuthService), 'login') as unknown as ReturnType<typeof vi.fn>;
  });

  async function submit(fixture: ComponentFixture<Login>): Promise<string> {
    const root = fixture.nativeElement as HTMLElement;
    const [email, password] = Array.from(root.querySelectorAll('input'));
    if (!email || !password) throw new Error('Campos em falta');
    email.value = 'ana@exemplo.pt';
    email.dispatchEvent(new Event('input'));
    password.value = 'segredo-segredo';
    password.dispatchEvent(new Event('input'));
    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    return root.textContent ?? '';
  }

  it('shows the generic server message for wrong credentials and stays on the page', async () => {
    login.mockReturnValue(
      throwError(
        () =>
          ({
            status: 401,
            code: 'INVALID_CREDENTIALS',
            message: 'Email ou palavra-passe inválidos.',
          }) satisfies ApiError,
      ),
    );
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();

    expect(await submit(fixture)).toContain('Email ou palavra-passe inválidos.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('tells the user how long to wait when rate limited (429 + Retry-After)', async () => {
    login.mockReturnValue(
      throwError(
        () =>
          ({
            status: 429,
            code: 'RATE_LIMITED',
            message: 'Demasiadas tentativas.',
            retryAfterSeconds: 610,
          }) satisfies ApiError,
      ),
    );
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    expect(await submit(fixture)).toContain('Tente novamente dentro de 11 min.');
  });

  it('never offers or pre-fills a password for the demo accounts', () => {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('admin@demo-a.invalid');
    expect(text).toContain('DEMO_USER_PASSWORD');
    expect(text).not.toContain('demo1234');
  });
});
