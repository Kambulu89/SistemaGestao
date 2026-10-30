import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  IamApi,
  type DecisionDto,
  type MemberDto,
  type PermissionDto,
  type PolicyDto,
  type RoleDto,
} from '../data-access/iam.api';
import { AccessSimulator } from './access-simulator';
import { PoliciesManager } from './policies-manager';
import { RolesManager } from './roles-manager';

const perm = (code: string, moduleCode: string): PermissionDto => ({
  id: code,
  code,
  moduleCode,
  description: `Permite ${code}`,
});
const CATALOG = [
  perm('party.read', 'party'),
  perm('party.update', 'party'),
  perm('catalog.read', 'catalog'),
  perm('iam.manage', 'iam'),
];

const role = (over: Partial<RoleDto> = {}): RoleDto => ({
  id: 'r1',
  code: 'vendas',
  name: 'Vendas',
  description: 'Equipa comercial',
  isSystem: false,
  version: 1,
  permissionCodes: ['party.read'],
  ...over,
});
const SYSTEM = role({
  id: 'r0',
  code: 'tenant_admin',
  name: 'Administrador',
  isSystem: true,
  permissionCodes: ['iam.manage', 'party.read'],
});

const policy = (over: Partial<PolicyDto> = {}): PolicyDto => ({
  id: 'p1',
  name: 'Sem despesas altas',
  resource: 'party',
  action: 'update',
  effect: 'DENY',
  condition: { op: 'gt', left: { var: 'resource.amount' }, right: { value: 1000 } },
  priority: 0,
  status: 'DRAFT',
  fieldRules: [],
  version: 1,
  ...over,
});

const member = (over: Partial<MemberDto> = {}): MemberDto => ({
  id: 'm1',
  userId: 'u1',
  email: 'ana@exemplo.invalid',
  displayName: 'Ana',
  status: 'ACTIVE',
  joinedAt: null,
  authorizationVersion: 1,
  version: 1,
  roles: [],
  ...over,
});

async function render<T>(
  component: Type<T>,
  api: Partial<IamApi> = {},
  granted: readonly string[] = ['iam.read', 'iam.manage'],
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      {
        provide: IamApi,
        useValue: {
          listRoles: () => of([SYSTEM, role()]),
          permissions: () => of(CATALOG),
          policies: () => of([policy()]),
          listMembers: () => of([member()]),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(component);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const field = (label: string) => {
    const lab = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    return el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `#${lab?.htmlFor}`,
    )!;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  const check = async (label: string) => {
    const box = field(label) as HTMLInputElement;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    await settle();
  };
  const click = async (label: string, index = 0) => {
    const matches = [...el.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === label,
    );
    matches[index]!.click();
    await settle();
    await settle();
  };
  const has = (label: string) =>
    [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
  return { el, type, check, click, has, field, settle };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Perfis', () => {
  it('lista os perfis, distingue os do sistema e só deixa editar ou apagar os outros', async () => {
    const { el } = await render(RolesManager);
    const rows = [...el.querySelectorAll('[data-testid=roles] tbody tr')].map((r) => text(r));
    expect(rows[0]).toContain('Administrador');
    expect(rows[0]).toContain('Sistema');
    expect(rows[0]).toContain('Ver');
    expect(rows[0]).not.toContain('Apagar');
    expect(rows[1]).toContain('Vendas');
    expect(rows[1]).toContain('Editar');
    expect(rows[1]).toContain('Apagar');
  });

  it('cria um perfil com as permissões escolhidas, agrupadas por módulo', async () => {
    const createRole = vi.fn(() =>
      of(
        role({
          id: 'r2',
          code: 'compras',
          name: 'Compras',
          permissionCodes: ['catalog.read', 'party.read'],
        }),
      ),
    );
    const { el, click, type, check } = await render(RolesManager, { createRole });
    await click('Novo perfil');
    expect(el.querySelectorAll('[data-testid=permission-groups] fieldset').length).toBe(3);
    await type('Código', 'compras');
    await type('Nome', 'Compras');
    await check('party.read');
    await check('catalog.read');
    await click('Guardar');
    expect(createRole).toHaveBeenCalledWith('compras', {
      name: 'Compras',
      description: null,
      permissionCodes: ['catalog.read', 'party.read'],
    });
    expect(el.textContent).toContain('Perfil criado.');
  });

  it('recusa um código inválido antes de chamar o servidor', async () => {
    const createRole = vi.fn();
    const { el, click, type } = await render(RolesManager, { createRole });
    await click('Novo perfil');
    await type('Código', 'Nome Com Espaços');
    await type('Nome', 'X');
    await click('Guardar');
    expect(createRole).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Código: minúsculas');
  });

  it('altera um perfil com a versão que leu e mostra o conflito do servidor', async () => {
    const updateRole = vi.fn(() =>
      throwError(() => ({
        status: 409,
        code: 'LAST_ADMIN',
        message: 'O último administrador não pode perder a gestão de acessos.',
      })),
    );
    const { el, click, check } = await render(RolesManager, { updateRole });
    await click('Editar');
    await check('catalog.read');
    await click('Guardar');
    expect(updateRole).toHaveBeenCalledWith(
      'r1',
      1,
      expect.objectContaining({ permissionCodes: ['catalog.read', 'party.read'] }),
    );
    expect(el.textContent).toContain('último administrador');
  });

  it('apaga um perfil depois de confirmar', async () => {
    const deleteRole = vi.fn(() => of(undefined));
    const { el, click } = await render(RolesManager, { deleteRole });
    await click('Apagar');
    expect(deleteRole).not.toHaveBeenCalled();
    expect(el.textContent).toContain('deixa de existir');
    await click('Apagar', 1);
    expect(deleteRole).toHaveBeenCalledWith('r1');
    expect(el.textContent).toContain('Perfil apagado.');
  });

  it('sem iam.manage só se consulta: sem criar, apagar nem guardar', async () => {
    const { has, click, el } = await render(RolesManager, {}, ['iam.read']);
    expect(has('Novo perfil')).toBe(false);
    expect(has('Apagar')).toBe(false);
    await click('Ver');
    expect(has('Guardar')).toBe(false);
    expect(el.textContent).toContain('Só leitura');
  });
});

describe('Políticas de acesso', () => {
  it('lista a política com o que a condição diz e o estado', async () => {
    const { el } = await render(PoliciesManager);
    const row = text(el.querySelector('[data-testid=policies] tbody tr'));
    expect(row).toContain('Sem despesas altas');
    expect(row).toContain('party.update');
    expect(row).toContain('Negar');
    expect(row).toContain('resource.amount é maior que 1000');
    expect(row).toContain('Rascunho');
  });

  it('activar e desactivar enviam só o estado, com a versão lida', async () => {
    const updatePolicy = vi.fn(() => of(policy({ status: 'ACTIVE', version: 2 })));
    const { click, el } = await render(PoliciesManager, { updatePolicy });
    await click('Activar');
    expect(updatePolicy).toHaveBeenCalledWith('p1', 1, { status: 'ACTIVE' });
    expect(el.textContent).toContain('Política activada.');
  });

  it('cria uma política em rascunho com a condição construída', async () => {
    const createPolicy = vi.fn(() => of(policy({ id: 'p2', name: 'Novo' })));
    const { click, type } = await render(PoliciesManager, { createPolicy });
    await click('Nova política');
    await type('Nome', 'Limite de despesa');
    await type('Recurso', 'party');
    await type('Acção', 'update');
    await click('Acrescentar condição');
    await type('Caminho', 'amount');
    await type('Compara', 'gt');
    await type('Tipo', 'number');
    await type('Valor', '1000');
    await click('Guardar como rascunho');
    expect(createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Limite de despesa',
        resource: 'party',
        action: 'update',
        effect: 'DENY',
        status: 'DRAFT',
        condition: { op: 'gt', left: { var: 'resource.amount' }, right: { value: 1000 } },
      }),
    );
  });

  it('recusa um caminho inválido e uma regra de campo sem campo', async () => {
    const createPolicy = vi.fn();
    const { el, click, type } = await render(PoliciesManager, { createPolicy });
    await click('Nova política');
    await type('Nome', 'X');
    await type('Recurso', 'party');
    await type('Acção', 'update');
    await click('Acrescentar condição');
    await type('Caminho', 'a b');
    await click('Guardar como rascunho');
    expect(createPolicy).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Condição 1');
  });

  it('uma condição avançada mantém-se tal como está ao guardar', async () => {
    const advanced = {
      op: 'and',
      args: [
        { op: 'or', args: [{ op: 'true' }, { op: 'true' }] },
        { op: 'eq', left: { var: 'subject.a' }, right: { value: 1 } },
      ],
    };
    const updatePolicy = vi.fn(() => of(policy({ condition: advanced, version: 2 })));
    const { el, click } = await render(PoliciesManager, {
      policies: () => of([policy({ condition: advanced })]),
      updatePolicy,
    });
    await click('Editar');
    expect(el.querySelector('[data-testid=advanced]')).not.toBeNull();
    await click('Guardar como rascunho');
    expect(updatePolicy).toHaveBeenCalledWith(
      'p1',
      1,
      expect.objectContaining({ condition: advanced }),
    );
  });

  it('as regras de campo vão com a política', async () => {
    const updatePolicy = vi.fn(() => of(policy({ version: 2 })));
    const { click, type } = await render(PoliciesManager, { updatePolicy });
    await click('Editar');
    await click('Acrescentar regra de campo');
    await type('Campo', 'salary');
    await type('Modo', 'READ_ONLY');
    await click('Guardar como rascunho');
    expect(updatePolicy).toHaveBeenCalledWith(
      'p1',
      1,
      expect.objectContaining({ fieldRules: [{ field: 'salary', mode: 'READ_ONLY' }] }),
    );
  });

  it('sem iam.manage só se consulta', async () => {
    const { has } = await render(PoliciesManager, {}, ['iam.read']);
    expect(has('Nova política')).toBe(false);
    expect(has('Activar')).toBe(false);
  });
});

describe('Simulador', () => {
  const decision = (over: Partial<DecisionDto> = {}): DecisionDto => ({
    allowed: false,
    reason: 'POLICY_DENY',
    grantedBy: [{ roleId: 'r1', roleCode: 'vendas' }],
    policies: [{ id: 'p1', name: 'Sem despesas altas', effect: 'DENY' }],
    hiddenFields: ['salary'],
    readOnlyFields: [],
    ...over,
  });

  it('mostra a decisão, os perfis, as políticas e os campos escondidos', async () => {
    const simulate = vi.fn(() => of(decision()));
    const { el, click, type } = await render(AccessSimulator, { simulate });
    await type('Membro', 'm1');
    await type('Permissão', 'party.update');
    await type('Recurso', '{"amount": 1500}');
    await click('Simular');
    expect(simulate).toHaveBeenCalledWith({
      membershipId: 'm1',
      permission: 'party.update',
      resource: { amount: 1500 },
    });
    expect(text(el.querySelector('[data-testid=decision]'))).toContain('Negado');
    expect(text(el.querySelector('[data-testid=decision]'))).toContain('Uma política activa nega');
    expect(text(el.querySelector('[data-testid=roles]'))).toBe('vendas');
    expect(text(el.querySelector('[data-testid=policies]'))).toBe('Sem despesas altas (negar)');
    expect(el.textContent).toContain('salary');
  });

  it('exige membro e permissão e recusa um recurso que não é um objecto JSON', async () => {
    const simulate = vi.fn();
    const { el, click, type } = await render(AccessSimulator, { simulate });
    await click('Simular');
    expect(el.textContent).toContain('Escolha o membro e a permissão.');
    await type('Membro', 'm1');
    await type('Permissão', 'party.update');
    await type('Recurso', '[1, 2]');
    await click('Simular');
    expect(simulate).not.toHaveBeenCalled();
    expect(el.textContent).toContain('objecto JSON');
  });

  it('um permitido mostra a razão positiva', async () => {
    const simulate = vi.fn(() =>
      of(decision({ allowed: true, reason: 'GRANTED', policies: [], hiddenFields: [] })),
    );
    const { el, click, type } = await render(AccessSimulator, { simulate });
    await type('Membro', 'm1');
    await type('Permissão', 'party.read');
    await click('Simular');
    expect(text(el.querySelector('[data-testid=decision]'))).toContain('Permitido');
  });
});
