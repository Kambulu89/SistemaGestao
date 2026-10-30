import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  OrganizationApi,
  type OrganizationDto,
  type UnitDto,
} from '../data-access/organization.api';
import { TenantOrganization } from './organization';

const org = (id: string, code: string): OrganizationDto => ({
  id,
  code,
  legalName: `Empresa ${code}, Lda.`,
  tradeName: null,
  countryCode: 'AO',
  baseCurrency: 'AOA',
  active: true,
  version: 1,
});

const unit = (id: string, code: string, parentId: string | null, active = true): UnitDto => ({
  id,
  organizationId: 'o1',
  parentId,
  code,
  name: `Unidade ${code}`,
  type: 'DEPARTMENT',
  active,
  version: 2,
});

describe('TenantOrganization', () => {
  let api: {
    listOrganizations: ReturnType<typeof vi.fn>;
    listUnits: ReturnType<typeof vi.fn>;
    createUnit: ReturnType<typeof vi.fn>;
    setUnitActive: ReturnType<typeof vi.fn>;
  };
  let granted: Set<string>;
  const tenant = signal<{ id: string } | null>({ id: 't1' });

  async function render(): Promise<ComponentFixture<TenantOrganization>> {
    const fixture = TestBed.createComponent(TenantOrganization);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const root = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
  const text = (f: ComponentFixture<unknown>) => root(f).textContent ?? '';
  const button = (f: ComponentFixture<unknown>, label: string) =>
    Array.from(root(f).querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  beforeEach(() => {
    granted = new Set(['organization.read', 'organization.manage']);
    tenant.set({ id: 't1' });
    api = {
      listOrganizations: vi.fn(() => of([org('o1', 'ORG-1')])),
      listUnits: vi.fn(() =>
        of([unit('u3', 'EQ-1', 'u2'), unit('u2', 'VENDAS', 'u1'), unit('u1', 'SEDE', null)]),
      ),
      createUnit: vi.fn(() => of(unit('u9', 'NOVA', null))),
      setUnitActive: vi.fn(() => of(unit('u1', 'SEDE', null, false))),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: OrganizationApi, useValue: api },
        { provide: PermissionService, useValue: { can: (p: string) => granted.has(p) } },
        { provide: TenantContextService, useValue: { tenant } },
      ],
    });
  });

  it('shows the organization and its units as an ordered tree', async () => {
    const f = await render();
    expect(text(f)).toContain('Empresa ORG-1, Lda.');
    expect(text(f)).toContain('moeda base AOA');
    expect(api.listUnits).toHaveBeenCalledWith('o1');
    const names = Array.from(root(f).querySelectorAll('tbody tr')).map((r) =>
      r.querySelector('td')?.textContent?.trim(),
    );
    expect(names).toEqual(['Unidade SEDE', 'Unidade VENDAS', 'Unidade EQ-1']);
  });

  it('read-only users see the tree but no actions', async () => {
    granted = new Set(['organization.read']);
    const f = await render();
    expect(text(f)).toContain('Unidade SEDE');
    expect(button(f, 'Nova unidade')).toBeUndefined();
    expect(button(f, 'Inactivar')).toBeUndefined();
  });

  it('shows empty states for no organization and no units', async () => {
    api.listOrganizations.mockReturnValue(of([]));
    let f = await render();
    expect(text(f)).toContain('Ainda não há organizações');

    api.listOrganizations.mockReturnValue(of([org('o1', 'ORG-1')]));
    api.listUnits.mockReturnValue(of([]));
    f = await render();
    expect(text(f)).toContain('Sem unidades nesta organização');
  });

  it('shows load errors', async () => {
    api.listOrganizations.mockReturnValue(
      throwError(() => ({ status: 500, message: 'Ocorreu um erro interno.' }) satisfies ApiError),
    );
    const f = await render();
    expect(text(f)).toContain('Não foi possível carregar a organização');
    expect(text(f)).toContain('Ocorreu um erro interno.');
  });

  async function openCreate(f: ComponentFixture<TenantOrganization>, code: string, name: string) {
    button(f, 'Nova unidade')!.click();
    f.detectChanges();
    const inputs = Array.from(root(f).querySelectorAll<HTMLInputElement>('dialog input'));
    [code, name].forEach((value, index) => {
      const input = inputs[index];
      if (!input) throw new Error('Campo em falta no diálogo');
      input.value = value;
      input.dispatchEvent(new Event('input'));
    });
    f.detectChanges();
  }

  const submit = async (f: ComponentFixture<unknown>) => {
    root(f).querySelector('dialog form')!.dispatchEvent(new Event('submit'));
    await f.whenStable();
    f.detectChanges();
  };

  it('creates a unit in the selected organization and reloads', async () => {
    const f = await render();
    await openCreate(f, ' NOVA ', ' Nova unidade ');
    await submit(f);

    expect(api.createUnit).toHaveBeenCalledWith({
      organizationId: 'o1',
      parentId: null,
      code: 'NOVA',
      name: 'Nova unidade',
      type: 'OTHER',
    });
    expect(api.listUnits).toHaveBeenCalledTimes(2);
    expect(text(f)).toContain('Unidade criada.');
  });

  it('puts a duplicate code (409) on the code field', async () => {
    api.createUnit.mockReturnValue(
      throwError(
        () =>
          ({
            status: 409,
            code: 'UNIT_CODE_TAKEN',
            message: 'Já existe uma unidade com este código na organização.',
          }) satisfies ApiError,
      ),
    );
    const f = await render();
    await openCreate(f, 'SEDE', 'Outra');
    await submit(f);

    expect(text(f)).toContain('Já existe uma unidade com este código na organização.');
    expect(api.listUnits).toHaveBeenCalledTimes(1);
  });

  it('puts server validation errors on their fields', async () => {
    api.createUnit.mockReturnValue(
      throwError(
        () =>
          ({
            status: 422,
            code: 'VALIDATION_ERROR',
            message: 'Verifique os campos indicados.',
            fieldErrors: [
              {
                path: 'parentId',
                code: 'INVALID_PARENT',
                message: 'A unidade pai não existe nesta organização.',
              },
            ],
          }) satisfies ApiError,
      ),
    );
    const f = await render();
    await openCreate(f, 'X1', 'Teste');
    await submit(f);
    expect(text(f)).toContain('A unidade pai não existe nesta organização.');
  });

  it('does not submit an invalid form', async () => {
    const f = await render();
    await openCreate(f, '', '');
    await submit(f);
    expect(api.createUnit).not.toHaveBeenCalled();
    expect(text(f)).toContain('Campo obrigatório.');
  });

  it('toggles a unit with its version and asks to retry on a version conflict', async () => {
    const f = await render();
    button(f, 'Inactivar')!.click();
    await f.whenStable();
    expect(api.setUnitActive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', version: 2 }),
      false,
    );
    expect(text(f)).toContain('Unidade inactivada.');

    api.setUnitActive.mockReturnValue(
      throwError(
        () => ({ status: 409, code: 'VERSION_CONFLICT', message: 'x' }) satisfies ApiError,
      ),
    );
    button(f, 'Inactivar')!.click();
    await f.whenStable();
    f.detectChanges();
    expect(text(f)).toContain('alterada entretanto por outra pessoa');
  });

  it('reloads the organizations when the tenant changes', async () => {
    const f = await render();
    tenant.set({ id: 't2' });
    f.detectChanges();
    await f.whenStable();
    expect(api.listOrganizations).toHaveBeenCalledTimes(2);
  });
});
