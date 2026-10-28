import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { IamApi } from '../data-access/iam.api';
import { OrganizationApi, type UnitDto } from '../data-access/organization.api';
import { CostCentersPanel } from './cost-centers-panel';
import { TeamPanel } from './team-panel';

const UNIT = { id: 'u1', organizationId: 'o1', code: 'LIS', name: 'Lisboa' } as UnitDto;

function configure(org: Record<string, unknown>, granted = ['organization.manage', 'member.read']) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      {
        provide: IamApi,
        useValue: {
          listMembers: () =>
            of([{ id: 'm1', displayName: 'Ana', email: 'a@x.invalid', status: 'ACTIVE' }]),
        },
      },
      { provide: OrganizationApi, useValue: org },
    ],
  });
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const field = (el: HTMLElement, label: string) => {
  const lab = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
};
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('CostCentersPanel', () => {
  const center = {
    id: 'c1',
    organizationId: 'o1',
    parentId: null,
    code: 'CC1',
    name: 'Comercial',
    responsibleMembershipId: 'm1',
    active: true,
    version: 3,
  };

  it('lista com o nome do responsável e inactiva com a versão esperada', async () => {
    const updateCostCenter = vi.fn(() => of(center));
    configure({ listCostCenters: () => of([center]), updateCostCenter });
    const fixture = TestBed.createComponent(CostCentersPanel);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Comercial');
    expect(el.textContent).toContain('Ana');
    button(el, 'Inactivar').click();
    expect(updateCostCenter).toHaveBeenCalledWith(center, { active: false });
  });

  it('exige código e nome antes de criar', async () => {
    const createCostCenter = vi.fn(() => of(center));
    configure({ listCostCenters: () => of([]), createCostCenter });
    const fixture = TestBed.createComponent(CostCentersPanel);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Criar centro de custo').click();
    await settle(fixture);
    expect(createCostCenter).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indique o código e o nome');
    const code = field(el, 'Código');
    code.value = 'CC2';
    code.dispatchEvent(new Event('input'));
    const name = field(el, 'Nome');
    name.value = 'Operações';
    name.dispatchEvent(new Event('input'));
    await settle(fixture);
    button(el, 'Criar centro de custo').click();
    expect(createCostCenter).toHaveBeenCalledWith({
      organizationId: 'o1',
      parentId: null,
      code: 'CC2',
      name: 'Operações',
      responsibleMembershipId: null,
    });
  });

  it('sem organization.manage não mostra o formulário nem acções', async () => {
    configure({ listCostCenters: () => of([center]) }, ['member.read']);
    const fixture = TestBed.createComponent(CostCentersPanel);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid=cost-center-form]')).toBeNull();
    expect(el.querySelectorAll('button').length).toBe(0);
  });
});

describe('TeamPanel', () => {
  it('mostra a equipa da unidade escolhida e remove um membro', async () => {
    const removeTeamMember = vi.fn(() => of(undefined));
    configure({
      listTeam: vi.fn(() =>
        of([
          {
            id: 't1',
            unitId: 'u1',
            membershipId: 'm1',
            startsOn: '2026-01-01',
            endsOn: null,
            roleLabel: 'Chefe',
          },
        ]),
      ),
      removeTeamMember,
    });
    const fixture = TestBed.createComponent(TeamPanel);
    fixture.componentRef.setInput('units', [UNIT]);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const select = field(el, 'Unidade') as HTMLSelectElement;
    select.value = 'u1';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    await settle(fixture);
    expect(el.querySelector('[data-testid=team]')?.textContent).toContain('Ana');
    expect(el.querySelector('[data-testid=team]')?.textContent).toContain('Chefe');
    button(el, 'Remover').click();
    expect(removeTeamMember).toHaveBeenCalledWith('t1');
  });

  it('valida o período antes de adicionar', async () => {
    const addTeamMember = vi.fn(() => of({}));
    configure({ listTeam: () => of([]), addTeamMember });
    const fixture = TestBed.createComponent(TeamPanel);
    fixture.componentRef.setInput('units', [UNIT]);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const select = field(el, 'Unidade') as HTMLSelectElement;
    select.value = 'u1';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    await settle(fixture);
    button(el, 'Adicionar à equipa').click();
    await settle(fixture);
    expect(addTeamMember).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Escolha o membro');
  });
});
