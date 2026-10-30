import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { IamApi, type MemberDto } from '../data-access/iam.api';
import { OrganizationApi } from '../data-access/organization.api';
import { MemberAccessPanel } from './member-access-panel';

const MEMBER = {
  id: 'm1',
  displayName: 'Ana',
  email: 'ana@exemplo.invalid',
} as MemberDto;

@Component({
  imports: [MemberAccessPanel],
  template: `<app-member-access-panel [member]="member()" (changed)="changes = changes + 1" />`,
})
class Host {
  readonly member = signal<MemberDto | null>(MEMBER);
  changes = 0;
}

async function setup(granted = ['iam.read', 'iam.manage'], iam: Record<string, unknown> = {}) {
  const api = {
    assignments: vi.fn(() =>
      of([
        {
          id: 'a1',
          membershipId: 'm1',
          roleId: 'r1',
          organizationUnitId: null,
          validFrom: null,
          validUntil: null,
        },
      ]),
    ),
    scopes: vi.fn(() =>
      of([
        {
          id: 's1',
          membershipId: 'm1',
          organizationId: 'o1',
          organizationUnitId: 'u1',
          includeDescendants: true,
        },
      ]),
    ),
    listRoles: () => of([{ id: 'r1', name: 'Vendas' }]),
    assign: vi.fn(() => of({})),
    revokeAssignment: vi.fn(() => of(undefined)),
    addScope: vi.fn(() => of({})),
    removeScope: vi.fn(() => of(undefined)),
    ...iam,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: IamApi, useValue: api },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: () => of([{ id: 'o1' }]),
          listUnits: () => of([{ id: 'u1', organizationId: 'o1', code: 'LIS', name: 'Lisboa' }]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = document.body;
  const click = async (label: string) => {
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click();
    await settle();
  };
  return { api, el, click, settle, fixture };
}

describe('MemberAccessPanel', () => {
  it('lista perfis e âmbitos com os nomes legíveis', async () => {
    const { el } = await setup();
    expect(el.querySelector('[data-testid=assignments]')?.textContent).toContain('Vendas');
    expect(el.querySelector('[data-testid=scopes]')?.textContent).toContain('Lisboa');
    expect(el.querySelector('[data-testid=scopes]')?.textContent).toContain('sub-unidades');
  });

  it('revoga uma atribuição e avisa a lista', async () => {
    const { api, click, fixture } = await setup();
    await click('Revogar');
    expect(api.revokeAssignment).toHaveBeenCalledWith('a1');
    expect(fixture.componentInstance.changes).toBe(1);
  });

  it('remove um âmbito', async () => {
    const { api, click } = await setup();
    await click('Remover');
    expect(api.removeScope).toHaveBeenCalledWith('s1');
  });

  it('exige o perfil antes de atribuir', async () => {
    const { api, click, el } = await setup();
    await click('Atribuir perfil');
    expect(api.assign).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Escolha o perfil');
  });

  it('sem iam.manage só mostra, sem acções', async () => {
    const { el } = await setup(['iam.read']);
    expect(el.querySelector('[data-testid=assign-form]')).toBeNull();
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Revogar'),
    ).toBe(false);
  });

  it('mostra o erro do servidor ao falhar', async () => {
    const { click, el } = await setup(['iam.read', 'iam.manage'], {
      revokeAssignment: () => throwError(() => ({ code: 'CONFLICT', message: 'Já revogada.' })),
    });
    await click('Revogar');
    expect(el.textContent).toContain('Já revogada.');
  });
});
