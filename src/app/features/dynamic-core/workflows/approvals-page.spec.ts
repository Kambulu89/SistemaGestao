import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { IamApi } from '../../tenant/data-access/iam.api';
import { ApprovalsPage } from './approvals-page';
import { ApprovalsApi, type DelegationDto, type TaskViewDto } from './workflows.api';

const task = (over: Partial<TaskViewDto> = {}): TaskViewDto => ({
  task: {
    id: 't1',
    instanceId: 'i1',
    stageCode: 'chefia',
    stageIndex: 0,
    assigneeMembershipId: 'm-chef',
    candidateRoleId: null,
    status: 'OPEN',
    dueAt: '2026-10-30T10:00:00.000Z',
    decidedByMembershipId: null,
    decisionReason: null,
    decidedAt: null,
  },
  workflow: { code: 'aprovacao', name: 'Aprovação de despesa', revision: 2 },
  entityCode: 'despesa',
  recordId: 'r1',
  resourceVersion: 3,
  submittedByMembershipId: 'm-ana',
  stage: { code: 'chefia', label: 'Chefia', criteria: 'ALL' },
  amount: '1500.00',
  currency: 'EUR',
  overdue: false,
  can: { claim: false, decide: true },
  delegated: false,
  ...over,
});

const delegation = (over: Partial<DelegationDto> = {}): DelegationDto => ({
  id: 'd1',
  fromMembershipId: 'm-chef',
  toMembershipId: 'm-ana',
  validFrom: '2026-10-23T10:00:00.000Z',
  validUntil: '2026-10-30T10:00:00.000Z',
  scope: { workflowCodes: ['aprovacao'] },
  maxAmount: '1000.0000',
  currency: 'EUR',
  reason: 'Férias',
  revokedAt: null,
  version: 1,
  direction: 'GIVEN',
  ...over,
});

const members = [
  { id: 'm-ana', displayName: 'Ana', email: 'ana@x.pt', status: 'ACTIVE' },
  { id: 'm-chef', displayName: 'Chefe', email: 'chefe@x.pt', status: 'ACTIVE' },
];

async function render(inbox: TaskViewDto[], api: Partial<ApprovalsApi> = {}, delegate = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: DynamicEntityRegistryService,
        useValue: { find: () => ({ names: { singular: 'Despesa', plural: 'Despesas' } }) },
      },
      { provide: PermissionService, useValue: { can: () => delegate } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'demo' }) } },
      { provide: IamApi, useValue: { listMembers: () => of(members) } },
      {
        provide: ApprovalsApi,
        useValue: {
          inbox: () => of(inbox),
          delegations: () => of([delegation(), delegation({ id: 'd2', direction: 'RECEIVED' })]),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ApprovalsPage);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string, within: ParentNode = el) =>
    [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const field = (within: ParentNode, label: string) => {
    const lab = [...within.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    return within.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `#${lab?.htmlFor}`,
    )!;
  };
  const type = async (within: ParentNode, label: string, value: string) => {
    const input = field(within, label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  return { el, settle, button, type };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Caixa de aprovações', () => {
  it('mostra o pedido, o solicitante, a etapa, o valor, o prazo e a versão submetida', async () => {
    const { el } = await render([task()]);
    const row = text(el.querySelector('[data-testid=inbox] tbody tr'))!;
    expect(row).toContain('Despesa');
    expect(row).toContain('Aprovação de despesa');
    expect(row).toContain('Ana');
    expect(row).toContain('Chefia');
    expect(row).toContain('Todos aprovam');
    expect(row).toContain('1500.00 EUR');
    expect(row).toContain('30/10/2026');
    expect(row).toContain('v3');
    const link = el.querySelector<HTMLAnchorElement>('[data-testid=inbox] tbody a')!;
    expect(link.getAttribute('href')).toBe('/t/demo/data/despesa/r1');
  });

  it('liga ao registo pela chave do URL, não pelo código do servidor', async () => {
    const { el } = await render([task({ entityCode: 'ordem_servico' })]);
    const link = el.querySelector<HTMLAnchorElement>('[data-testid=inbox] tbody a')!;
    expect(link.getAttribute('href')).toBe('/t/demo/data/ordem-servico/r1');
  });

  it('assinala o prazo vencido e o que se trata por delegação', async () => {
    const { el } = await render([task({ overdue: true, delegated: true })]);
    const row = text(el.querySelector('[data-testid=inbox] tbody tr'))!;
    expect(row).toContain('Em atraso');
    expect(row).toContain('Por delegação');
  });

  it('só oferece as acções que o servidor permite', async () => {
    const { el } = await render([
      task(),
      task({ task: { ...task().task, id: 't2' }, can: { claim: true, decide: false } }),
      task({ task: { ...task().task, id: 't3' }, can: { claim: false, decide: false } }),
    ]);
    const rows = [...el.querySelectorAll('[data-testid=inbox] tbody tr')].map((r) =>
      [...r.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    );
    expect(rows).toEqual([['Aprovar', 'Rejeitar', 'Devolver'], ['Reclamar'], []]);
  });

  it('aprova sem pedir motivo', async () => {
    const calls: unknown[] = [];
    const { button, settle, el } = await render([task()], {
      decide: (id: string, action: string, reason: string | null) => {
        calls.push([id, action, reason]);
        return of({ ...task(), idempotent: false });
      },
    });
    button('Aprovar')!.click();
    await settle();
    expect(calls).toEqual([['t1', 'approve', null]]);
    expect(text(el.querySelector('app-alert'))).toContain('Aprovado.');
  });

  it('rejeitar e devolver exigem o motivo', async () => {
    const calls: unknown[] = [];
    const { el, button, settle, type } = await render([task()], {
      decide: (id: string, action: string, reason: string | null) => {
        calls.push([id, action, reason]);
        return of({ ...task(), idempotent: false });
      },
    });
    button('Rejeitar')!.click();
    await settle();
    const dialog = el.querySelector('dialog[open]')!;
    expect(button('Confirmar', dialog)!.disabled).toBe(true);
    await type(dialog, 'Motivo', 'Sem verba');
    expect(button('Confirmar', dialog)!.disabled).toBe(false);
    button('Confirmar', dialog)!.click();
    await settle();
    expect(calls).toEqual([['t1', 'reject', 'Sem verba']]);
  });

  it('reclama uma tarefa de grupo', async () => {
    const claimed: string[] = [];
    const { button, settle } = await render([task({ can: { claim: true, decide: false } })], {
      claim: (id: string) => {
        claimed.push(id);
        return of(task());
      },
    });
    button('Reclamar')!.click();
    await settle();
    expect(claimed).toEqual(['t1']);
  });

  it('mostra o erro do servidor e recarrega (ex.: tarefa já decidida)', async () => {
    const { button, settle, el } = await render([task()], {
      decide: () =>
        throwError(() => ({ code: 'TASK_ALREADY_DECIDED', message: 'A tarefa já foi decidida.' })),
    });
    button('Aprovar')!.click();
    await settle();
    expect(text(el.querySelector('app-alert[ng-reflect-tone=danger], app-alert'))).toContain(
      'já foi decidida',
    );
  });

  it('lista as minhas delegações e só deixa revogar as que dei', async () => {
    const revoked: unknown[] = [];
    const { el, button, settle } = await render([], {
      revokeDelegation: (id: string, version: number) => {
        revoked.push([id, version]);
        return of(delegation());
      },
    });
    const rows = [...el.querySelectorAll('[data-testid=delegations] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain('Chefe → Ana');
    expect(text(rows[0])).toContain('aprovacao');
    expect(text(rows[0])).toContain('até 1000.0000 EUR');
    expect(rows[0]?.querySelectorAll('button')).toHaveLength(1);
    expect(rows[1]?.querySelectorAll('button')).toHaveLength(0);
    button('Revogar')!.click();
    await settle();
    expect(revoked).toEqual([['d1', 1]]);
  });

  it('cria uma delegação com âmbito e montante máximo', async () => {
    const bodies: unknown[] = [];
    const { el, button, settle, type } = await render([], {
      delegate: (body: unknown) => {
        bodies.push(body);
        return of(delegation());
      },
    });
    button('Nova delegação')!.click();
    await settle();
    const dialog = el.querySelector('dialog[open]')!;
    expect(button('Delegar', dialog)!.disabled).toBe(true);
    await type(dialog, 'Delegar em', 'm-ana');
    await type(dialog, 'Válida até', '2026-11-05T10:00');
    await type(dialog, 'Workflows abrangidos', 'aprovacao, ferias');
    await type(dialog, 'Montante máximo', '1000.00');
    await type(dialog, 'Moeda', 'eur');
    await type(dialog, 'Motivo', 'Férias');
    button('Delegar', dialog)!.click();
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      toMembershipId: 'm-ana',
      scope: { workflowCodes: ['aprovacao', 'ferias'] },
      maxAmount: '1000.00',
      currency: 'EUR',
      reason: 'Férias',
    });
  });

  it('sem approval.delegate não há secção de delegações', async () => {
    const { el } = await render([task()], {}, false);
    expect(el.querySelector('[data-testid=delegations]')).toBeNull();
    expect(text(el)).not.toContain('As minhas delegações');
  });
});
