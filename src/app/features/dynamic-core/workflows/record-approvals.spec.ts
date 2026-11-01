import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { RecordApprovals } from './record-approvals';
import { ApprovalsApi, type InstanceDto } from './workflows.api';

const instance = (over: Partial<InstanceDto> = {}): InstanceDto => ({
  id: 'i1',
  workflowCode: 'aprovacao',
  workflowName: 'Aprovação de despesa',
  workflowRevision: 2,
  entityCode: 'despesa',
  recordId: 'r1',
  resourceVersion: 3,
  status: 'WAITING',
  endReason: null,
  currentStageIndex: 0,
  submittedByMembershipId: 'm1',
  startedAt: '2026-10-23T10:00:00.000Z',
  endedAt: null,
  ...over,
});

async function render(instances: InstanceDto[], api: Partial<ApprovalsApi> = {}, canSubmit = true) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: PermissionService,
        useValue: { can: (p: string) => canSubmit && p === 'workflow.submit' },
      },
      {
        provide: ApprovalsApi,
        useValue: {
          instancesOf: () => of(instances),
          instance: (id: string) =>
            of({
              instance: instances[0],
              tasks: [
                {
                  id: 't1',
                  instanceId: id,
                  stageCode: 'chefia',
                  stageIndex: 0,
                  assigneeMembershipId: 'm2',
                  candidateRoleId: null,
                  status: 'OPEN',
                  dueAt: null,
                  decidedByMembershipId: null,
                  decisionReason: null,
                  decidedAt: null,
                },
              ],
            }),
          submittable: () =>
            of([
              {
                code: 'aprovacao',
                name: 'Aprovação de despesa',
                revision: 2,
                stages: [
                  { code: 'chefia', label: 'Chefia' },
                  { code: 'direcao', label: 'Direcção' },
                ],
              },
            ]),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RecordApprovals);
  fixture.componentRef.setInput('entityCode', 'despesa');
  fixture.componentRef.setInput('recordId', 'r1');
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
  return { el, settle, button };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Aprovação do registo', () => {
  it('mostra o processo em curso, a versão submetida e as tarefas', async () => {
    const { el } = await render([instance()]);
    const current = text(el.querySelector('[data-testid=approval-current]'))!;
    expect(current).toContain('A aguardar decisão');
    expect(current).toContain('Aprovação de despesa (revisão 2)');
    expect(current).toContain('versão 3');
    expect(text(el.querySelector('ol'))).toContain('chefia');
    expect(text(el.querySelector('ol'))).toContain('Por decidir');
    // Com um processo em curso não se submete outro.
    expect(el.querySelector('[data-testid=submit-approval]')).toBeNull();
  });

  it('diz porque terminou um processo cancelado', async () => {
    const { el } = await render([instance({ status: 'CANCELLED', endReason: 'RESOURCE_CHANGED' })]);
    expect(text(el.querySelector('[data-testid=approvals-panel]'))).toContain(
      'Cancelado porque o registo foi alterado depois de submetido.',
    );
    expect(el.querySelector('[data-testid=submit-approval]')).not.toBeNull();
  });

  it('submete a um workflow publicado e mostra as etapas antes de confirmar', async () => {
    const calls: unknown[] = [];
    const { el, settle, button } = await render([], {
      submit: (entityCode: string, workflowCode: string, recordId: string) => {
        calls.push([entityCode, workflowCode, recordId]);
        return of({ instance: instance(), tasks: [] });
      },
    });
    expect(text(el)).toContain('ainda não foi submetido');
    el.querySelector<HTMLButtonElement>('[data-testid=submit-approval]')!.click();
    await settle();
    const dialog = el.querySelector('dialog[open]')!;
    expect(button('Submeter', dialog)!.disabled).toBe(true);
    const select = dialog.querySelector<HTMLSelectElement>('select')!;
    select.value = 'aprovacao';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(text(dialog)).toContain('Chefia → Direcção');
    button('Submeter', dialog)!.click();
    await settle();
    expect(calls).toEqual([['despesa', 'aprovacao', 'r1']]);
    expect(text(el)).toContain('Submetido para aprovação.');
  });

  it('mostra o erro do servidor (ex.: sem responsável resolvível)', async () => {
    const { el, settle, button } = await render([], {
      submit: () =>
        throwError(() => ({
          code: 'NO_RESOLVABLE_APPROVER',
          message: 'Algum responsável não é resolvível.',
        })),
    });
    el.querySelector<HTMLButtonElement>('[data-testid=submit-approval]')!.click();
    await settle();
    const dialog = el.querySelector('dialog[open]')!;
    const select = dialog.querySelector<HTMLSelectElement>('select')!;
    select.value = 'aprovacao';
    select.dispatchEvent(new Event('change'));
    await settle();
    button('Submeter', dialog)!.click();
    await settle();
    expect(text(el)).toContain('não é resolvível');
  });

  it('cancela o processo em curso', async () => {
    const cancelled: string[] = [];
    const { settle, button } = await render([instance()], {
      cancel: (id: string) => {
        cancelled.push(id);
        return of({ instance: instance({ status: 'CANCELLED' }), tasks: [] });
      },
    });
    button('Cancelar processo')!.click();
    await settle();
    expect(cancelled).toEqual(['i1']);
  });

  it('não aparece a quem não pode submeter e não tem processos', async () => {
    const { el } = await render([], {}, false);
    expect(el.querySelector('[data-testid=approvals-panel]')).toBeNull();
  });
});
