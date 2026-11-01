import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { defineEntity } from '../../../core/dynamic/engine/define-entity';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { IamApi } from '../../tenant/data-access/iam.api';
import { EntityWorkflowsPage } from './entity-workflows-page';
import { WorkflowsApi, type WorkflowBody, type WorkflowDto } from './workflows.api';

const entity = defineEntity({
  key: 'despesa',
  scope: 'tenant',
  tenantId: 't1',
  moduleId: null,
  version: 1,
  state: 'published',
  names: { singular: 'Despesa', plural: 'Despesas' },
  icon: 'cube',
  fields: [
    { type: 'text', key: 'descricao', label: 'Descrição', required: true },
    { type: 'decimal', key: 'valor', label: 'Valor', scale: 2 },
    { type: 'text', key: 'moeda', label: 'Moeda' },
    { type: 'text', key: 'segredo', label: 'Segredo', sensitivity: 'sensitive' },
  ],
  meta: { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
});

const workflow = (over: Partial<WorkflowDto> = {}): WorkflowDto => ({
  id: 'w1',
  entityCode: 'despesa',
  code: 'aprovacao',
  name: 'Aprovação',
  description: null,
  revision: 1,
  version: 4,
  status: 'DRAFT',
  graph: {
    stages: [
      {
        code: 'chefia',
        label: 'Chefia',
        approvers: [{ type: 'MEMBERSHIP', id: 'm1' }],
        criteria: 'ALL',
        allowSelfApproval: false,
      },
    ],
  },
  issues: [],
  ...over,
});

const members = [
  { id: 'm1', displayName: 'Ana', email: 'ana@x.pt', status: 'ACTIVE' },
  { id: 'm2', displayName: 'Rui', email: 'rui@x.pt', status: 'ACTIVE' },
  { id: 'm3', displayName: 'Saiu', email: 's@x.pt', status: 'LEFT' },
];
const roles = [{ id: 'r1', name: 'Direcção' }];

async function render(list: WorkflowDto[], api: Partial<WorkflowsApi> = {}, publish = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DynamicEntityRegistryService, useValue: { find: () => entity } },
      {
        provide: PermissionService,
        useValue: { can: (p: string) => publish || !p.endsWith('publish') },
      },
      { provide: IamApi, useValue: { listMembers: () => of(members), listRoles: () => of(roles) } },
      { provide: WorkflowsApi, useValue: { list: () => of(list), ...api } },
    ],
  });
  const fixture = TestBed.createComponent(EntityWorkflowsPage);
  fixture.componentRef.setInput('entityKey', 'despesa');
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
    return within.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
  };
  const type = async (within: ParentNode, label: string, value: string) => {
    const input = field(within, label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  return { el, settle, button, field, type };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Designer de workflows', () => {
  it('lista as revisões com o estado e as acções permitidas', async () => {
    const { el } = await render([
      workflow(),
      workflow({
        id: 'w2',
        code: 'outro',
        status: 'PUBLISHED',
        issues: [{ path: 'x', code: 'X', message: 'm' }],
      }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => text(r));
    expect(rows[0]).toContain('1 etapa(s)');
    expect(rows[0]).toContain('Rascunho');
    expect(rows[0]).toContain('Editar');
    expect(rows[0]).toContain('Publicar');
    expect(rows[1]).toContain('Publicado');
    expect(rows[1]).toContain('Com problemas');
    expect(rows[1]).toContain('Retirar');
    expect(rows[1]).toContain('Nova revisão');
  });

  it('sem workflow.publish não há «Publicar» nem «Retirar»', async () => {
    const { button } = await render([workflow()], {}, false);
    expect(button('Publicar')).toBeUndefined();
    expect(button('Editar')).toBeDefined();
  });

  it('cria um workflow: etapa, responsável, quórum, montante e o corpo segue para o servidor', async () => {
    const created: { entityCode: string; code: string; body: WorkflowBody }[] = [];
    const { el, settle, button, field, type } = await render([], {
      create: (entityCode: string, code: string, body: unknown) => {
        created.push({ entityCode, code, body: body as WorkflowBody });
        return of(workflow({ id: 'w9', version: 1 }));
      },
    });
    button('Novo workflow')!.click();
    await settle();
    await type(el, 'Nome', 'Aprovação de despesa');
    await type(el, 'Código', 'aprovacao_despesa');
    await type(el, 'Campo do montante', 'valor');
    await type(el, 'Campo da moeda', 'moeda');

    // O fluxo mostra o que falta antes de perguntar ao servidor.
    expect(text(el.querySelector('[data-testid=problems]'))).toContain('não tem responsáveis');

    const stage = el.querySelector('[data-testid=stage-0]')!;
    await type(stage, 'Nome da etapa', 'Chefia directa');
    expect((field(stage, 'Código') as HTMLInputElement).value).toBe('chefia_directa');

    await type(stage, 'Responsável', 'm1');
    button('Adicionar', stage)!.click();
    await settle();
    await type(stage, 'Responsável', 'm2');
    button('Adicionar', stage)!.click();
    await settle();
    expect(text(el.querySelector('[data-testid=approvers-0]'))).toContain('Ana');
    expect(text(el.querySelector('[data-testid=approvers-0]'))).toContain('Rui');

    // Papéis geram tarefas de grupo.
    await type(stage, 'Tipo', 'ROLE');
    await type(stage, 'Responsável', 'r1');
    button('Adicionar', stage)!.click();
    await settle();
    expect(text(el.querySelector('[data-testid=approvers-0]'))).toContain('Direcção');
    expect(text(el.querySelector('[data-testid=approvers-0]'))).toContain('grupo');

    await type(stage, 'Critério', 'QUORUM');
    expect((field(stage, 'Aprovações necessárias') as HTMLInputElement).value).toBe('2');
    await type(stage, 'Aprovações necessárias', '3');
    await type(stage, 'Prazo (horas)', '48');
    expect(text(el.querySelector('[data-testid=flow]'))).toContain(
      '3 aprovações de 3 responsáveis em 48 h',
    );
    expect(el.querySelector('[data-testid=problems]')).toBeNull();

    button('Guardar rascunho')!.click();
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.entityCode).toBe('despesa');
    expect(created[0]?.code).toBe('aprovacao_despesa');
    expect(created[0]?.body.graph).toEqual({
      amountField: 'valor',
      currencyField: 'moeda',
      stages: [
        {
          code: 'chefia_directa',
          label: 'Chefia directa',
          approvers: [
            { type: 'MEMBERSHIP', id: 'm1' },
            { type: 'MEMBERSHIP', id: 'm2' },
            { type: 'ROLE', id: 'r1' },
          ],
          criteria: 'QUORUM',
          quorum: 3,
          dueInHours: 48,
          allowSelfApproval: false,
        },
      ],
    });
  });

  it('só oferece montantes decimais e nunca campos sensíveis na condição', async () => {
    const { el, settle, button } = await render([workflow()]);
    button('Editar')!.click();
    await settle();
    const amount = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith('Campo do montante'),
    )!;
    const options = [...el.querySelectorAll<HTMLOptionElement>(`#${amount.htmlFor} option`)].map(
      (o) => o.textContent?.trim(),
    );
    expect(options).toContain('Valor');
    expect(options).not.toContain('Descrição');
    expect(options).not.toContain('Segredo');

    const stage = el.querySelector('[data-testid=stage-0]')!;
    button('Definir condição', stage)!.click();
    await settle();
    const fieldOptions = [
      ...stage.querySelectorAll<HTMLOptionElement>('[data-testid=condition-0] select option'),
    ].map((o) => o.textContent?.trim());
    expect(fieldOptions).toContain('Valor');
    expect(fieldOptions).not.toContain('Segredo');
  });

  it('mostra os problemas que o servidor encontra ao verificar', async () => {
    const { el, settle, button } = await render([workflow()], {
      update: (id: string, version: number) => of(workflow({ id, version: version + 1 })),
      preview: () =>
        of({
          issues: [
            {
              path: 'graph.stages[0].approvers[0]',
              code: 'APPROVER_UNRESOLVABLE',
              message: 'O membro não existe ou não está activo.',
            },
          ],
          publishable: false,
        }),
    });
    button('Editar')!.click();
    await settle();
    button('Verificar com o servidor')!.click();
    await settle();
    expect(text(el.querySelector('[data-testid=issues]'))).toContain('não está activo');
    expect(el.querySelector('[data-testid=verified]')).toBeNull();
  });

  it('uma etapa pode subir, descer e ser removida', async () => {
    const { el, settle, button } = await render([
      workflow({
        graph: {
          stages: [
            { code: 'a_a', label: 'A', approvers: [], criteria: 'ALL', allowSelfApproval: false },
            { code: 'b_b', label: 'B', approvers: [], criteria: 'ALL', allowSelfApproval: false },
          ],
        },
      }),
    ]);
    button('Editar')!.click();
    await settle();
    const labels = () => [...el.querySelectorAll('[data-testid=flow] strong')].map((s) => text(s));
    expect(labels()).toEqual(['1. A', '2. B']);
    button('Descer', el.querySelector('[data-testid=stage-0]')!)!.click();
    await settle();
    expect(labels()).toEqual(['1. B', '2. A']);
    button('Remover etapa', el.querySelector('[data-testid=stage-0]')!)!.click();
    await settle();
    expect(labels()).toEqual(['1. A']);
  });
});
