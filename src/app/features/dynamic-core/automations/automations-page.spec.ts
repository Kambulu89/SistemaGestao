import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { AutomationsPage } from './automations-page';
import {
  AutomationsApi,
  type AutomationDto,
  type CatalogDto,
  type RunDto,
} from './automations.api';

const catalog: CatalogDto = {
  events: [
    {
      type: 'dynamic.record.state_changed',
      label: 'Um registo mudou de estado',
      fields: [
        { name: 'recordId', kind: 'text' },
        { name: 'toState', kind: 'text' },
      ],
    },
  ],
  actions: [
    {
      type: 'dynamic.record.transition',
      label: 'Executar uma transição',
      description: 'Executa a transição como o membro da automação.',
      params: [
        { name: 'entityCode', kind: 'text', required: true, description: 'Código da entidade.' },
        { name: 'recordId', kind: 'text', required: true, description: 'O registo.' },
        { name: 'transition', kind: 'text', required: true, description: 'A transição.' },
      ],
    },
  ],
};

const automation = (over: Partial<AutomationDto> = {}): AutomationDto => ({
  id: 'a1',
  code: 'concluir_auto',
  name: 'Concluir automaticamente',
  description: null,
  eventType: 'dynamic.record.state_changed',
  schedule: null,
  timezone: 'Africa/Luanda',
  condition: null,
  actions: [
    {
      type: 'dynamic.record.transition',
      params: {
        entityCode: 'pedido',
        recordId: { from: 'payload.recordId' },
        transition: 'concluir',
      },
    },
  ],
  status: 'DRAFT',
  maxRunsPerPeriod: 60,
  runAsMembershipId: null,
  activatedAt: null,
  nextRunAt: null,
  version: 2,
  issues: [],
  ...over,
});

const run = (over: Partial<RunDto> = {}): RunDto => ({
  id: 'r1',
  automationId: 'a1',
  automationCode: 'concluir_auto',
  automationVersion: 2,
  status: 'SUCCEEDED',
  attempts: 1,
  nextAttemptAt: '2026-10-23T10:00:00.000Z',
  depth: 1,
  progress: 1,
  error: null,
  errorCode: null,
  scheduledFor: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  finishedAt: '2026-10-23T10:00:01.000Z',
  retriedAt: null,
  version: 3,
  ...over,
});

async function render(
  list: AutomationDto[],
  runs: RunDto[] = [],
  api: Partial<AutomationsApi> = {},
  manage = true,
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: () => manage } },
      {
        provide: AutomationsApi,
        useValue: {
          catalog: () => of(catalog),
          list: () => of(list),
          runs: () => of(runs),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AutomationsPage);
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
  return { el, settle, button, field, type };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Automações', () => {
  it('lista o gatilho pelo rótulo do catálogo, o estado e a próxima execução com o fuso', async () => {
    const { el } = await render([
      automation(),
      automation({
        id: 'a2',
        code: 'diaria',
        name: 'Diária',
        eventType: null,
        schedule: '0 9 * * *',
        status: 'ACTIVE',
        nextRunAt: '2026-10-24T08:00:00.000Z',
        issues: [{ path: 'x', code: 'X', message: 'm' }],
      }),
    ]);
    const rows = [...el.querySelectorAll('[data-testid=automations] tbody tr')].map((r) => text(r));
    expect(rows[0]).toContain('Um registo mudou de estado');
    expect(rows[0]).toContain('Rascunho');
    expect(rows[0]).toContain('Activar');
    expect(rows[1]).toContain('Calendário «0 9 * * *» (Africa/Luanda)');
    expect(rows[1]).toContain('Activa');
    expect(rows[1]).toContain('Com problemas');
    expect(rows[1]).toContain('24/10/2026');
    expect(rows[1]).toContain('Africa/Luanda');
    expect(rows[1]).toContain('Pausar');
    expect(rows[1]).not.toContain('Editar');
  });

  it('sem automation.manage só se vê (sem criar, activar, pausar nem reprocessar)', async () => {
    const { el } = await render(
      [automation()],
      [run({ status: 'DEAD', errorCode: 'ACTION_FAILED', error: 'x' })],
      {},
      false,
    );
    expect(text(el)).not.toContain('Nova automação');
    expect(text(el.querySelector('[data-testid=automations]'))).not.toContain('Activar');
    expect(text(el.querySelector('[data-testid=runs]'))).not.toContain('Reprocessar');
  });

  it('o histórico explica as falhas e só deixa reprocessar as que o motor não fechou', async () => {
    const { el } = await render(
      [automation({ status: 'ACTIVE' })],
      [
        run({ id: 'r1', status: 'DEAD', errorCode: 'ACTION_FAILED', error: 'A transição falhou.' }),
        run({ id: 'r2', status: 'DEAD', errorCode: 'CAUSALITY_DEPTH', depth: 5 }),
        run({ id: 'r3', status: 'PENDING', attempts: 2, errorCode: 'ACTION_FAILED', error: 'x' }),
        run({ id: 'r4' }),
      ],
    );
    const rows = [...el.querySelectorAll('[data-testid=runs] tbody tr')].map((r) => text(r)!);
    expect(rows[0]).toContain('Fila de falhas');
    expect(rows[0]).toContain('A transição falhou.');
    expect(rows[0]).toContain('Reprocessar');
    expect(rows[1]).toContain('A cadeia de causalidade excedeu o limite de níveis.');
    expect(rows[1]).not.toContain('Reprocessar');
    expect(rows[2]).toContain('Na fila');
    expect(rows[2]).toContain('próxima');
    expect(rows[2]).not.toContain('Reprocessar');
    expect(rows[3]).toContain('Concluída');
  });

  it('reprocessa com a versão da execução e mostra o resultado', async () => {
    const calls: unknown[] = [];
    const { el, button, settle } = await render(
      [automation()],
      [run({ status: 'DEAD', errorCode: 'ACTION_FAILED', error: 'x', version: 7 })],
      {
        retry: (id: string, version: number) => {
          calls.push([id, version]);
          return of(run());
        },
      },
    );
    button('Reprocessar')!.click();
    await settle();
    expect(calls).toEqual([['r1', 7]]);
    expect(text(el.querySelector('app-alert'))).toContain('Execução devolvida à fila.');
  });

  it('o histórico filtra por automação', async () => {
    const seen: (string | undefined)[] = [];
    const { button, settle } = await render([automation()], [], {
      runs: (id?: string) => {
        seen.push(id);
        return of([]);
      },
    });
    button('Histórico')!.click();
    await settle();
    expect(seen).toContain(undefined);
    expect(seen.at(-1)).toBe('a1');
  });

  it('activa e pausa com a versão actual', async () => {
    const calls: string[] = [];
    const { button, settle } = await render(
      [
        automation({ id: 'a1' }),
        automation({ id: 'a2', code: 'b_b', status: 'ACTIVE', version: 5 }),
      ],
      [],
      {
        activate: (id: string, version: number) => {
          calls.push(`activate ${id} ${version}`);
          return of(automation());
        },
        pause: (id: string, version: number) => {
          calls.push(`pause ${id} ${version}`);
          return of(automation());
        },
      },
    );
    button('Activar')!.click();
    await settle();
    button('Pausar')!.click();
    await settle();
    expect(calls).toEqual(['activate a1 2', 'pause a2 5']);
  });

  it('cria uma automação: gatilho do catálogo, parâmetros fixos e do evento, e o corpo segue para o servidor', async () => {
    const created: { code: string; body: Record<string, unknown> }[] = [];
    const { el, settle, button, type } = await render([], [], {
      create: (code: string, body: unknown) => {
        created.push({ code, body: body as Record<string, unknown> });
        return of(automation({ id: 'a9', version: 1 }));
      },
    });
    button('Nova automação')!.click();
    await settle();
    await type(el, 'Nome', 'Concluir automaticamente');
    await type(el, 'Código', 'concluir_auto');
    await type(el, 'Evento', 'dynamic.record.state_changed');
    await type(el, 'Máximo de execuções por hora', '10');

    button('Adicionar acção')!.click();
    await settle();
    const action = el.querySelector('[data-testid=action-0]')!;
    expect(text(action)).toContain('Executa a transição como o membro da automação.');
    // Os parâmetros começam como valor fixo; o do registo vem do evento.
    const labels = [...action.querySelectorAll('label')].map((l) => l.textContent?.trim());
    expect(labels).toContain('entityCode *');
    await type(action, 'entityCode', 'fixed');
    const valueInputs = [...action.querySelectorAll<HTMLInputElement>('input')];
    valueInputs[0]!.value = 'pedido';
    valueInputs[0]!.dispatchEvent(new Event('input'));
    await settle();
    await type(action, 'recordId', 'event');
    await type(action, 'Campo do evento', 'recordId');
    const remaining = [...action.querySelectorAll<HTMLInputElement>('input')];
    remaining.at(-1)!.value = 'concluir';
    remaining.at(-1)!.dispatchEvent(new Event('input'));
    await settle();

    button('Guardar rascunho')!.click();
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.code).toBe('concluir_auto');
    expect(created[0]?.body).toMatchObject({
      name: 'Concluir automaticamente',
      eventType: 'dynamic.record.state_changed',
      schedule: null,
      maxRunsPerPeriod: 10,
      condition: null,
    });
    const actions = created[0]?.body['actions'] as { params: Record<string, unknown> }[];
    expect(actions[0]?.params['recordId']).toEqual({ from: 'payload.recordId' });
    expect(actions[0]?.params['entityCode']).toBe('pedido');
  });

  it('um gatilho de calendário não oferece condição nem campos do evento, e envia o fuso', async () => {
    const created: Record<string, unknown>[] = [];
    const { el, settle, button, type } = await render([], [], {
      create: (_code: string, body: unknown) => {
        created.push(body as Record<string, unknown>);
        return of(automation({ id: 'a9', version: 1 }));
      },
    });
    button('Nova automação')!.click();
    await settle();
    await type(el, 'Nome', 'Diária');
    await type(el, 'Código', 'diaria');
    await type(el, 'Quando', 'schedule');
    await type(el, 'Calendário', '0 9 * * 1-5');
    await type(el, 'Fuso horário', 'Africa/Luanda');
    expect(el.querySelector('[data-testid=condition]')).toBeNull();
    button('Guardar rascunho')!.click();
    await settle();
    expect(created[0]).toMatchObject({
      eventType: null,
      schedule: '0 9 * * 1-5',
      timezone: 'Africa/Luanda',
      condition: null,
    });
  });

  it('mostra os problemas que o servidor encontra ao activar', async () => {
    const { el, settle, button } = await render([automation()], [], {
      update: (id: string, version: number) => of(automation({ id, version: version + 1 })),
      activate: () =>
        throwError(() => ({
          code: 'VALIDATION_ERROR',
          message: 'Verifique os campos indicados.',
          fieldErrors: [
            {
              path: 'actions[0].type',
              code: 'UNKNOWN_ACTION',
              message: 'A acção não está disponível.',
            },
          ],
        })),
    });
    button('Editar')!.click();
    await settle();
    button('Guardar e activar')!.click();
    await settle();
    expect(text(el.querySelector('[data-testid=issues]'))).toContain(
      'A acção não está disponível.',
    );
  });

  it('simula com um evento de exemplo e mostra a condição e os parâmetros resolvidos', async () => {
    const samples: unknown[] = [];
    const { el, settle, button, type } = await render([automation()], [], {
      update: (id: string, version: number) => of(automation({ id, version: version + 1 })),
      simulate: (_id: string, payload: unknown) => {
        samples.push(payload);
        return of({
          conditionPassed: true,
          conditionError: null,
          actions: [
            {
              type: 'dynamic.record.transition',
              params: { entityCode: 'pedido', recordId: 'r-1', transition: 'concluir' },
              error: null,
            },
          ],
          nextRuns: [],
        });
      },
    });
    button('Editar')!.click();
    await settle();
    await type(el, 'Evento de exemplo', '{"recordId": "r-1", "toState": "em_curso"}');
    button('Simular')!.click();
    await settle();
    expect(samples).toEqual([{ recordId: 'r-1', toState: 'em_curso' }]);
    const result = text(el.querySelector('[data-testid=simulation]'))!;
    expect(result).toContain('verifica-se (executaria)');
    expect(result).toContain('"recordId":"r-1"');
  });

  it('recusa um evento de exemplo que não seja um objecto JSON', async () => {
    const { el, settle, button, type } = await render([automation()]);
    button('Editar')!.click();
    await settle();
    await type(el, 'Evento de exemplo', '[1, 2]');
    button('Simular')!.click();
    await settle();
    expect(text(el)).toContain('objecto JSON');
  });
});
