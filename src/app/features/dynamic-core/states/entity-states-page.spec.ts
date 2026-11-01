import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { defineEntity } from '../../../core/dynamic/engine/define-entity';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { EntityStatesPage } from './entity-states-page';
import { StatesApi, type MachineDto } from './states.api';

const entity = defineEntity({
  key: 'ticket',
  scope: 'tenant',
  tenantId: 't1',
  moduleId: null,
  version: 1,
  state: 'published',
  names: { singular: 'Ticket', plural: 'Tickets' },
  icon: 'cube',
  fields: [
    { type: 'text', key: 'assunto', label: 'Assunto', required: true },
    { type: 'number', key: 'valorTotal', label: 'Valor total' },
    { type: 'text', key: 'segredo', label: 'Segredo', sensitivity: 'sensitive' },
  ],
  meta: { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
});

const machine = (over: Partial<MachineDto> = {}): MachineDto => ({
  id: 'm1',
  entityCode: 'ticket',
  code: 'ciclo',
  name: 'Ciclo',
  description: null,
  revision: 1,
  version: 3,
  status: 'DRAFT',
  initialStateCode: 'aberto',
  states: [
    { code: 'aberto', label: 'Aberto', category: 'INITIAL', editable: true },
    { code: 'feito', label: 'Feito', category: 'FINAL', editable: false },
    { code: 'perdido', label: 'Perdido', category: 'ACTIVE', editable: true },
  ],
  transitions: [
    { code: 'fechar', label: 'Fechar', from: ['aberto'], to: 'feito', reasonRequired: false },
  ],
  issues: [],
  ...over,
});

async function render(list: MachineDto[], api: Partial<StatesApi> = {}, publish = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DynamicEntityRegistryService, useValue: { find: () => entity } },
      {
        provide: PermissionService,
        useValue: { can: (p: string) => publish || !p.endsWith('publish') },
      },
      { provide: StatesApi, useValue: { list: () => of(list), ...api } },
    ],
  });
  const fixture = TestBed.createComponent(EntityStatesPage);
  fixture.componentRef.setInput('entityKey', 'ticket');
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

describe('Designer de máquinas de estados', () => {
  it('lista as revisões com o conteúdo, o estado e as acções do estado', async () => {
    const { el } = await render([
      machine(),
      machine({
        id: 'm2',
        code: 'outro',
        status: 'PUBLISHED',
        issues: [{ path: 'x', code: 'X', message: 'm' }],
      }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows[0]).toContain('3 estados · 1 transições');
    expect(rows[0]).toContain('Rascunho');
    expect(rows[0]).toContain('Editar');
    expect(rows[0]).toContain('Publicar');
    expect(rows[1]).toContain('Publicada');
    expect(rows[1]).toContain('Com problemas');
    expect(rows[1]).toContain('Retirar');
    expect(rows[1]).toContain('Nova revisão');
  });

  it('sem state.publish não há «Publicar» nem «Retirar»', async () => {
    const { button } = await render([machine()], {}, false);
    expect(button('Publicar')).toBeUndefined();
    expect(button('Editar')).toBeDefined();
  });

  it('o mapa mostra o que cada estado alcança e assinala o inalcançável', async () => {
    const { el, settle, button } = await render([machine()]);
    button('Editar')!.click();
    await settle();
    const map = el.querySelector('[data-testid=map]')!.textContent!.replace(/\s+/g, ' ');
    expect(map).toContain('AbertoInicial');
    expect(map).toContain('Fechar → Feito');
    expect(map).toContain('Fim do percurso.');
    expect(map).toContain('PerdidoActivoInalcançável');
    expect(map).toContain('Sem saídas.');
  });

  it('cria uma máquina: o código acompanha o rótulo, uma guarda é construída e o corpo segue para o servidor', async () => {
    const created: unknown[] = [];
    const { el, settle, button, field, type } = await render([], {
      create: (entityCode: string, code: string, body: unknown) => {
        created.push({ entityCode, code, body });
        return of(machine({ id: 'm9', version: 1 }));
      },
    });
    button('Nova máquina')!.click();
    await settle();
    await type(el, 'Nome', 'Ciclo do ticket');
    await type(el, 'Código', 'ciclo_ticket');

    // O primeiro estado nasce inicial; renomeá-lo acompanha o código gerado.
    const first = el.querySelector('[data-testid=state-0]')!;
    await type(first, 'Rótulo', 'Em análise');
    expect((field(first, 'Código') as HTMLInputElement).value).toBe('em_analise');

    button('Adicionar estado')!.click();
    await settle();
    const second = el.querySelector('[data-testid=state-1]')!;
    await type(second, 'Rótulo', 'Resolvido');
    await type(second, 'Categoria', 'FINAL');
    expect((field(second, 'Código') as HTMLInputElement).value).toBe('resolvido');

    button('Adicionar transição')!.click();
    await settle();
    const transition = el.querySelector('[data-testid=transition-0]')!;
    await type(transition, 'Rótulo (o que o botão diz)', 'Resolver');
    expect((field(transition, 'Código') as HTMLInputElement).value).toBe('resolver');
    await type(transition, 'Passa a', 'resolvido');
    const reason = field(transition, 'Exige um motivo') as HTMLInputElement;
    reason.checked = true;
    reason.dispatchEvent(new Event('change'));
    await settle();

    // Guarda: «Valor total é maior que 0».
    button('Definir condição', transition)!.click();
    await settle();
    const editor = transition.querySelector('[data-testid=guard-0]')!;
    await type(editor, 'Campo', 'valor_total');
    await type(editor, 'Condição', 'gt');
    await type(editor, 'Valor', '0');
    button('Aplicar', editor)!.click();
    await settle();
    expect(transition.querySelector('[data-testid=guard-0-summary]')?.textContent).toContain(
      'Valor total é maior que 0',
    );

    button('Guardar rascunho')!.click();
    await settle();
    expect(created).toEqual([
      {
        entityCode: 'ticket',
        code: 'ciclo_ticket',
        body: {
          name: 'Ciclo do ticket',
          description: null,
          states: [
            { code: 'em_analise', label: 'Em análise', category: 'INITIAL', editable: true },
            { code: 'resolvido', label: 'Resolvido', category: 'FINAL', editable: false },
          ],
          transitions: [
            {
              code: 'resolver',
              label: 'Resolver',
              from: ['em_analise'],
              to: 'resolvido',
              reasonRequired: true,
              guard: { op: 'gt', left: { var: 'resource.valor_total' }, right: { value: 0 } },
            },
          ],
        },
      },
    ]);
    expect(el.textContent).toContain('Rascunho guardado.');
  });

  it('um campo sensível não é oferecido nas guardas', async () => {
    const { el, settle, button } = await render([machine()]);
    button('Editar')!.click();
    await settle();
    const transition = el.querySelector('[data-testid=transition-0]')!;
    button('Definir condição', transition)!.click();
    await settle();
    const options = [
      ...transition.querySelectorAll('[data-testid=guard-0] select')[0]!.querySelectorAll('option'),
    ].map((o) => o.textContent?.trim());
    expect(options).toContain('Assunto');
    expect(options).toContain('Valor total');
    expect(options).not.toContain('Segredo');
  });

  it('remover um estado ajusta as transições e avisa', async () => {
    const { el, settle, button } = await render([machine()]);
    button('Editar')!.click();
    await settle();
    button('Remover', el.querySelector('[data-testid=state-1]')!)!.click();
    await settle();
    expect(el.querySelector('[data-testid=transitions]')!.textContent).toContain('Sem transições');
    expect(el.textContent).toContain('1 transição(ões) foram ajustadas ou removidas');
  });

  it('mostra os problemas do servidor, e «Verificar» seguido de «Publicar» fecha o editor', async () => {
    const calls: string[] = [];
    const { el, settle, button } = await render([machine()], {
      update: () => {
        calls.push('update');
        return of(machine({ version: 4 }));
      },
      preview: () => {
        calls.push('preview');
        return of({
          issues: [
            {
              path: 'states[2]',
              code: 'UNREACHABLE_STATE',
              message: 'O estado «perdido» não é alcançável.',
            },
          ],
          publishable: false,
        });
      },
      publish: (_id: string, version: number) => {
        calls.push(`publish:${version}`);
        return of(machine({ status: 'PUBLISHED', version: 5 }));
      },
    });
    button('Editar')!.click();
    await settle();
    button('Verificar com o servidor')!.click();
    await settle();
    expect(el.querySelector('[data-testid=issues]')?.textContent).toContain('não é alcançável');
    expect(el.querySelector('[data-testid=verified]')).toBeNull();
    button('Publicar')!.click();
    await settle();
    expect(calls).toEqual(['update', 'preview', 'update', 'publish:4']);
    expect(el.textContent).toContain('Máquina publicada.');
    expect(el.querySelector('[data-testid=map]')).toBeNull();
  });

  it('um 422 ao guardar mostra os caminhos devolvidos', async () => {
    const { el, settle, button } = await render([machine()], {
      update: () =>
        throwError(() => ({
          status: 422,
          message: 'Verifique os campos indicados.',
          fieldErrors: [
            {
              path: 'transitions[0].to',
              code: 'UNKNOWN_STATE',
              message: 'O estado «x» não existe.',
            },
          ],
        })),
    });
    button('Editar')!.click();
    await settle();
    button('Guardar rascunho')!.click();
    await settle();
    expect(el.querySelector('[data-testid=issues]')?.textContent).toContain('transitions[0].to');
  });
});
