import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../core/auth/auth.service';
import { ProfilePage } from './profile-page';
import { ProfileApi } from './profile.api';

const SESSIONS = [
  {
    id: 's1',
    createdAt: '2026-10-01T10:00:00Z',
    lastSeenAt: '2026-10-28T10:00:00Z',
    expiresAt: '2026-11-01T10:00:00Z',
    ip: '10.0.0.1',
    userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/120',
    current: true,
  },
  {
    id: 's2',
    createdAt: '2026-10-01T10:00:00Z',
    lastSeenAt: '2026-10-20T10:00:00Z',
    expiresAt: '2026-11-01T10:00:00Z',
    ip: null,
    userAgent: null,
    current: false,
  },
];

async function render(api: Record<string, unknown> = {}) {
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user: signal({ email: 'ana@x.invalid' }) } },
      {
        provide: ProfileApi,
        useValue: {
          sessions: () => of(SESSIONS),
          securityEvents: () =>
            of([
              {
                id: 'e1',
                type: 'LOGIN_SUCCEEDED',
                severity: 'INFO',
                occurredAt: '2026-10-28T10:00:00Z',
              },
            ]),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProfilePage);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const type = async (label: string, value: string) => {
    const lab = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    const input = el.querySelector<HTMLInputElement>(`#${lab?.htmlFor}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const click = async (label: string) => {
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click();
    await settle();
  };
  return { el, type, click };
}

describe('ProfilePage', () => {
  it('mostra sessões (a actual sem acção de terminar) e actividade traduzida', async () => {
    const { el } = await render();
    const sessions = el.querySelector('[data-testid=sessions]')!;
    expect(sessions.textContent).toContain('Chrome em Linux');
    expect(sessions.textContent).toContain('Esta sessão');
    expect(sessions.querySelectorAll('button').length).toBe(1);
    expect(el.querySelector('[data-testid=events]')?.textContent).toContain('Sessão iniciada');
  });

  it('termina outra sessão', async () => {
    const revokeSession = vi.fn(() => of(undefined));
    const { click, el } = await render({ revokeSession });
    await click('Terminar');
    expect(revokeSession).toHaveBeenCalledWith('s2');
    expect(el.textContent).toContain('Sessão terminada.');
  });

  it('valida localmente antes de alterar a palavra-passe', async () => {
    const changePassword = vi.fn(() => of(undefined));
    const { click, type, el } = await render({ changePassword });
    await click('Alterar palavra-passe');
    expect(el.textContent).toContain('Indique a palavra-passe actual.');
    await type('Palavra-passe actual', 'antiga');
    await type('Nova palavra-passe', 'nova-segura-123');
    await type('Confirmar nova palavra-passe', 'outra');
    await click('Alterar palavra-passe');
    expect(changePassword).not.toHaveBeenCalled();
    expect(el.textContent).toContain('confirmação não coincide');
  });

  it('altera a palavra-passe, limpa os campos e mostra erros do servidor', async () => {
    const changePassword = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => ({
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos.',
          fieldErrors: [{ path: 'newPassword', code: 'WEAK', message: 'Palavra-passe fraca.' }],
        })),
      )
      .mockReturnValueOnce(of(undefined));
    const { click, type, el } = await render({ changePassword });
    await type('Palavra-passe actual', 'antiga');
    await type('Nova palavra-passe', 'fraca');
    await type('Confirmar nova palavra-passe', 'fraca');
    await click('Alterar palavra-passe');
    expect(el.textContent).toContain('Palavra-passe fraca.');
    await click('Alterar palavra-passe');
    expect(changePassword).toHaveBeenLastCalledWith('antiga', 'fraca');
    expect(el.textContent).toContain('Palavra-passe alterada.');
    const first = el.querySelector<HTMLInputElement>('[data-testid=password-form] input')!;
    expect(first.value).toBe('');
  });
});
