import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { setupMockBackend } from '../../../core/testing/test-backend';
import { Login } from './login';

describe('Login', () => {
  beforeEach(() => setupMockBackend());

  async function render(returnUrl?: string) {
    const fixture = TestBed.createComponent(Login);
    if (returnUrl) fixture.componentRef.setInput('returnUrl', returnUrl);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  function submit(el: HTMLElement, email: string, password: string): void {
    const [emailInput, passwordInput] = Array.from(el.querySelectorAll('input'));
    for (const [input, value] of [
      [emailInput, email],
      [passwordInput, password],
    ] as const) {
      if (!input) continue;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
  }

  it('shows validation errors instead of calling the API when empty', async () => {
    const { fixture, el } = await render();
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('Campo obrigatório.');
  });

  it('shows the error returned for wrong credentials', async () => {
    const { fixture, el } = await render();
    submit(el, 'multi@demo.pt', 'errada');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[role=alert]')?.textContent).toContain('Credenciais inválidas.');
    });
  });

  it('navigates to the returnUrl after login', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { el } = await render('/t/escola-horizonte/modules/crm');
    submit(el, 'multi@demo.pt', 'demo1234');
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/t/escola-horizonte/modules/crm'),
    );
  });

  it('refuses external return URLs (open redirect)', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { el } = await render('//evil.example');
    submit(el, 'multi@demo.pt', 'demo1234');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });
});
