import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { defineEntity } from '../../../core/dynamic/engine/define-entity';
import { fieldAccessFromPermissions } from '../../../core/dynamic/engine/field-state';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import type { FormDto } from '../../../core/dynamic/http/dynamic-dto';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { EntityFormsPage } from './entity-forms-page';
import { FormsApi } from './forms.api';

const entity = defineEntity({
  key: 'pedido',
  scope: 'tenant',
  tenantId: 't1',
  moduleId: null,
  version: 1,
  state: 'published',
  names: { singular: 'Pedido', plural: 'Pedidos' },
  icon: 'cube',
  fields: [
    { type: 'text', key: 'descricao', label: 'Descrição', required: true },
    {
      type: 'select',
      key: 'prioridade',
      label: 'Prioridade',
      options: [
        { value: 'baixa', label: 'Baixa' },
        { value: 'alta', label: 'Alta' },
      ],
    },
    { type: 'text', key: 'motivoUrgencia', label: 'Motivo da urgência' },
    { type: 'text', key: 'segredo', label: 'Segredo', sensitivity: 'sensitive' },
  ],
  meta: { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
});

const form = (over: Partial<FormDto> = {}): FormDto => ({
  id: 'f1',
  entityCode: 'pedido',
  code: 'ficha',
  name: 'Ficha',
  description: null,
  revision: 1,
  version: 4,
  status: 'DRAFT',
  modes: ['create', 'edit', 'read'],
  isDefault: false,
  sections: [
    {
      key: 'dados',
      title: 'Dados',
      columns: 2,
      items: [
        { kind: 'field', field: 'descricao' },
        { kind: 'field', field: 'prioridade' },
      ],
    },
  ],
  publishedAt: null,
  issues: [],
  ...over,
});

async function render(list: FormDto[], api: Partial<FormsApi> = {}, publish = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DynamicEntityRegistryService, useValue: { find: () => entity } },
      {
        provide: PermissionService,
        useValue: { can: (p: string) => publish || !p.endsWith('publish') },
      },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'demo' }) } },
      {
        provide: EntityAccessService,
        useValue: { fieldAccess: fieldAccessFromPermissions(() => true) },
      },
      { provide: EntityRecordsGateway, useValue: { lookup: () => of([]) } },
      { provide: FormsApi, useValue: { list: () => of(list), ...api } },
    ],
  });
  const fixture = TestBed.createComponent(EntityFormsPage);
  fixture.componentRef.setInput('entityKey', 'pedido');
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
  return { fixture, el, settle, button };
}

describe('Form Builder', () => {
  it('lista as revisões com modos, estado e as acções do estado', async () => {
    const { el } = await render([
      form(),
      form({ id: 'f2', code: 'curta', status: 'PUBLISHED', isDefault: true, modes: ['create'] }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Rascunho');
    expect(rows[0]).toContain('Editar');
    expect(rows[0]).toContain('Publicar');
    expect(rows[1]).toContain('Publicado');
    expect(rows[1]).toContain('Criação · por omissão');
    expect(rows[1]).toContain('Retirar');
    expect(rows[1]).toContain('Nova revisão');
  });

  it('sem form.publish não há «Publicar»', async () => {
    const { button } = await render([form()], {}, false);
    expect(button('Publicar')).toBeUndefined();
    expect(button('Editar')).toBeDefined();
  });

  it('sem form.publish não há «Retirar»', async () => {
    const { button, el } = await render([form({ status: 'PUBLISHED' })], {}, false);
    expect(button('Retirar')).toBeUndefined();
    expect(el.textContent).toContain('Ficha');
  });

  it('cria um formulário: adiciona campos, configura e guarda com as secções do servidor', async () => {
    const created: unknown[] = [];
    const { el, settle, button, fixture } = await render([], {
      create: (entityCode: string, code: string, body: unknown) => {
        created.push({ entityCode, code, body });
        return of(form({ id: 'f9', version: 1 }));
      },
    });
    button('Novo formulário')!.click();
    await settle();

    const inputs = () => [
      ...el.querySelectorAll<HTMLInputElement>('input[type=text], input:not([type])'),
    ];
    const byLabel = (text: string) => {
      const label = [...el.querySelectorAll('label')].find((l) =>
        l.textContent?.trim().startsWith(text),
      );
      return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${label?.htmlFor}`)!;
    };
    const type = async (text: string, value: string) => {
      const input = byLabel(text);
      input.value = value;
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
      await settle();
    };
    expect(inputs().length).toBeGreaterThan(0);
    await type('Nome', 'Ficha curta');
    await type('Código', 'ficha_curta');
    // «Adicionar campo»: escolhe um campo livre e adiciona-o à secção.
    await type('Adicionar campo', 'descricao');
    button('Adicionar à secção')!.click();
    await settle();
    await type('Adicionar campo', 'prioridade');
    button('Adicionar à secção')!.click();
    await settle();
    expect(el.querySelector('[data-testid=item-0-0]')?.textContent).toContain('Descrição');
    expect(el.querySelector('[data-testid=item-0-1]')?.textContent).toContain('Prioridade');
    expect(el.querySelector('[data-testid=free-fields]')?.textContent).toContain(
      'Motivo da urgência',
    );

    // Configurar o primeiro item: ajuda e obrigatório.
    button('Configurar', el.querySelector('[data-testid=item-0-0]')!)!.click();
    await settle();
    await type('Texto de ajuda', 'O que é preciso fazer');
    const required = byLabel('Obrigatório neste formulário') as HTMLInputElement;
    required.checked = true;
    required.dispatchEvent(new Event('change'));
    await settle();

    button('Guardar rascunho')!.click();
    await settle();
    expect(created).toEqual([
      {
        entityCode: 'pedido',
        code: 'ficha_curta',
        body: {
          name: 'Ficha curta',
          description: null,
          modes: ['create', 'edit', 'read'],
          isDefault: false,
          sections: [
            {
              key: 'dados',
              title: 'Dados',
              columns: 2,
              items: [
                {
                  kind: 'field',
                  field: 'descricao',
                  help: 'O que é preciso fazer',
                  required: true,
                },
                { kind: 'field', field: 'prioridade' },
              ],
            },
          ],
        },
      },
    ]);
    expect(el.textContent).toContain('Rascunho guardado.');
    fixture.destroy();
  });

  it('a pré-visualização desenha o formulário em edição (rótulo do formulário e condição da secção)', async () => {
    const { el, settle, button } = await render([
      form({
        sections: [
          {
            key: 'dados',
            title: 'Dados do pedido',
            columns: 1,
            items: [{ kind: 'field', field: 'descricao', label: 'Resumo' }],
          },
          {
            key: 'urgencia',
            title: 'Urgência',
            columns: 1,
            visibleWhen: { op: 'eq', field: 'prioridade', value: 'alta' },
            items: [{ kind: 'field', field: 'motivo_urgencia' }],
          },
        ],
      }),
    ]);
    button('Editar')!.click();
    await settle();
    const preview = el.querySelector('[data-testid=preview]')!;
    expect(preview.textContent).toContain('Dados do pedido');
    expect(preview.textContent).toContain('Resumo');
    expect(preview.textContent).not.toContain('Urgência');
    // O resumo da condição aparece no editor da secção, com o rótulo do campo.
    expect(el.querySelector('[data-testid=section-condition-1-summary]')?.textContent).toContain(
      'Prioridade é igual a alta',
    );
  });

  it('mostra os problemas que o servidor encontra ao guardar', async () => {
    const { el, settle, button } = await render([form()], {
      update: () =>
        throwError(() => ({
          status: 422,
          message: 'Verifique os campos indicados.',
          fieldErrors: [
            {
              path: 'sections[0].items[1].field',
              code: 'FORM_UNKNOWN_FIELD',
              message: 'O campo «x» não existe.',
            },
          ],
        })),
    });
    button('Editar')!.click();
    await settle();
    button('Guardar rascunho')!.click();
    await settle();
    expect(el.querySelector('[data-testid=issues]')?.textContent).toContain(
      'O campo «x» não existe.',
    );
    expect(el.querySelector('[data-testid=issues]')?.textContent).toContain(
      'sections[0].items[1].field',
    );
  });

  it('«Verificar» guarda e confirma quando o servidor aceita; publicar fecha o editor', async () => {
    const calls: string[] = [];
    const { el, settle, button } = await render([form()], {
      update: () => {
        calls.push('update');
        return of(form({ version: 5 }));
      },
      preview: () => {
        calls.push('preview');
        return of({ issues: [], publishable: true, entityRevision: 1 });
      },
      publish: (_id: string, version: number) => {
        calls.push(`publish:${version}`);
        return of(form({ status: 'PUBLISHED', version: 6 }));
      },
    });
    button('Editar')!.click();
    await settle();
    button('Verificar com o servidor')!.click();
    await settle();
    expect(el.querySelector('[data-testid=verified]')).not.toBeNull();
    button('Publicar')!.click();
    await settle();
    expect(calls).toEqual(['update', 'preview', 'update', 'publish:5']);
    expect(el.textContent).toContain('Formulário publicado.');
    expect(el.querySelector('[data-testid=preview]')).toBeNull();
  });
});
