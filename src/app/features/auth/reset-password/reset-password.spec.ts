import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { setupMockBackend } from '../../../core/testing/test-backend';
import { ResetPassword } from './reset-password';

describe('ResetPassword', () => {
  let reset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupMockBackend();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    reset = vi.spyOn(TestBed.inject(AuthService), 'resetPassword') as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  function create(token: string | undefined): ComponentFixture<ResetPassword> {
    const fixture = TestBed.createComponent(ResetPassword);
    fixture.componentRef.setInput('token', token);
    fixture.detectChanges();
    return fixture;
  }

  const fill = async (fixture: ComponentFixture<ResetPassword>, password: string) => {
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = password;
    input.dispatchEvent(new Event('input'));
    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    return root.textContent ?? '';
  };

  it('refuses a link without token', () => {
    const text = (create(undefined).nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('A ligação é inválida.');
  });

  it('does not call the server with a too-short password', async () => {
    const text = await fill(create('tok'.repeat(10)), 'curta');
    expect(reset).not.toHaveBeenCalled();
    expect(text).toContain('Mínimo de 12 caracteres.');
  });

  it('sends the token and the new password, then confirms that sessions were ended', async () => {
    reset.mockReturnValue(of(undefined));
    const token = 'tok'.repeat(10);
    const text = await fill(create(token), 'uma-frase-bem-longa');
    expect(reset).toHaveBeenCalledWith(token, 'uma-frase-bem-longa');
    expect(text).toContain('todas as sessões foram terminadas');
  });

  it('shows the server message for an invalid or expired token', async () => {
    reset.mockReturnValue(
      throwError(() => ({
        status: 400,
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'A ligação é inválida ou expirou.',
      })),
    );
    const text = await fill(create('tok'.repeat(10)), 'uma-frase-bem-longa');
    expect(text).toContain('A ligação é inválida ou expirou.');
  });
});
