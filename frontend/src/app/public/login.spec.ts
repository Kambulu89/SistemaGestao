import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiError } from '../core/api';
import { Session } from '../core/session';
import { Login } from './login';

async function render(login: () => Promise<unknown>) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: Session, useValue: { login: vi.fn(login) } }],
  });
  const fixture = TestBed.createComponent(Login);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const type = (id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return { fixture, el, type, navigate, session: TestBed.inject(Session) };
}

describe('Login', () => {
  it('entra e segue para a aplicação', async () => {
    const { fixture, el, type, navigate, session } = await render(() => Promise.resolve({}));
    type('email', ' ana@exemplo.ao ');
    type('password', 'segredo-muito-longo');
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(session.login).toHaveBeenCalledWith('ana@exemplo.ao', 'segredo-muito-longo');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('mostra a mensagem genérica do servidor e limpa a palavra-passe', async () => {
    const { fixture, el, type, navigate } = await render(() =>
      Promise.reject(
        new ApiError(401, 'INVALID_CREDENTIALS', 'Email ou palavra-passe incorrectos.'),
      ),
    );
    type('email', 'ana@exemplo.ao');
    type('password', 'errada-mas-longa');
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('incorrectos');
    expect(el.querySelector<HTMLInputElement>('#password')!.value).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  });
});
