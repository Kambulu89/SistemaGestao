import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { defineEntity, defineField } from '../../../core/dynamic/engine/define-entity';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { EntityRulesPage } from './entity-rules-page';
import { RulesApi, type RuleDto } from './rules.api';

const entity = defineEntity({
  key: 'ordem-servico',
  scope: 'tenant',
  tenantId: 't1',
  moduleId: null,
  version: 1,
  state: 'published',
  names: { singular: 'Ordem', plural: 'Ordens' },
  icon: 'cube',
  fields: [
    defineField({ type: 'decimal', key: 'desconto', label: 'Desconto', scale: 2 }),
    defineField({ type: 'text', key: 'notaInterna', label: 'Nota interna' }),
    defineField({ type: 'text', key: 'segredo', label: 'Segredo', sensitivity: 'sensitive' }),
    defineField({ type: 'multiselect', key: 'etiquetas', label: 'Etiquetas', options: [] }),
  ],
  meta: { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
});

const rule = (over: Partial<RuleDto> = {}): RuleDto => ({
  id: 'r1',
  entityCode: 'ordem_servico',
  code: 'desconto_maximo',
  name: 'Desconto máximo',
  description: null,
  trigger: 'VALIDATE',
  revision: 1,
  priority: 100,
  conditionAst: { op: 'gt', left: { var: 'resource.desconto' }, right: { value: '20' } },
  actionAst: { type: 'BLOCK', message: 'Desconto acima da alçada.' },
  status: 'DRAFT',
  effectiveFrom: null,
  effectiveTo: null,
  publishedAt: null,
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

async function render(rules: RuleDto[], api: Partial<RulesApi> = {}, manage = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DynamicEntityRegistryService, useValue: { find: () => entity } },
      {
        provide: PermissionService,
        useValue: { can: (p: string) => manage || p === 'configuration.rules.read' },
      },
      { provide: RulesApi, useValue: { list: () => of(rules), ...api } },
    ],
  });
  const fixture = TestBed.createComponent(EntityRulesPage);
  fixture.componentRef.setInput('entityKey', 'ordem-servico');
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Regras da entidade', () => {
  it('lista as regras com mensagem, estado e acções do estado', async () => {
    const { el } = await render([
      rule(),
      rule({ id: 'r2', code: 'outra', name: 'Outra', status: 'PUBLISHED' }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Desconto acima da alçada.');
    expect(rows[0]).toContain('Rascunho');
    expect(rows[0]).toContain('Publicar');
    expect(rows[1]).toContain('Publicada');
    expect(rows[1]).toContain('Desactivar');
    expect(rows[1]).toContain('Nova revisão');
    expect(rows[1]).not.toContain('Publicar');
  });

  it('sem rule.manage só lê: não há acções de escrita nem «Nova regra»', async () => {
    const { el } = await render([rule()], {}, false);
    expect(button(el, 'Nova regra')).toBeUndefined();
    expect(button(el, 'Publicar')).toBeUndefined();
    expect(button(el, 'Simular')).toBeUndefined();
    expect(button(el, 'Avaliações')).toBeDefined();
  });

  it('publica com a versão de concorrência e recarrega', async () => {
    const calls: [string, number][] = [];
    const { el, fixture } = await render([rule()], {
      publish: (id: string, v: number) => {
        calls.push([id, v]);
        return of(rule({ status: 'PUBLISHED' }));
      },
    });
    button(el, 'Publicar')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(calls).toEqual([['r1', 3]]);
    expect(el.textContent).toContain('Regra publicada.');
  });

  it('simula só com os campos que a condição lê e mostra o resultado do servidor', async () => {
    const sent: unknown[] = [];
    const { el, fixture } = await render([rule()], {
      simulate: (_id: string, values: Record<string, unknown>) => {
        sent.push(values);
        return of({ result: 'FAIL' as const, message: 'Desconto acima da alçada.', reason: null });
      },
    });
    button(el, 'Simular')!.click();
    fixture.detectChanges();
    const labels = [...el.querySelectorAll('dialog label')].map((l) => l.textContent?.trim());
    expect(labels.some((l) => l?.startsWith('Desconto'))).toBe(true);
    expect(labels.some((l) => l?.startsWith('Nota interna'))).toBe(false);
    const input = el.querySelector<HTMLInputElement>('dialog input')!;
    input.value = '25';
    input.dispatchEvent(new Event('input'));
    const submit = [...el.querySelectorAll('dialog button[type=submit]')].at(-1) as HTMLElement;
    submit.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sent).toEqual([{ desconto: '25' }]);
    expect(el.querySelector('[data-testid=simulation-result]')?.textContent).toContain(
      'bloquearia',
    );
  });

  it('o construtor só oferece campos comparáveis e não sensíveis', async () => {
    const { el, fixture } = await render([]);
    button(el, 'Nova regra')!.click();
    fixture.detectChanges();
    const options = [...el.querySelectorAll('dialog select')[0]!.querySelectorAll('option')].map(
      (o) => o.textContent?.trim(),
    );
    expect(options).toContain('Desconto');
    expect(options).toContain('Nota interna');
    expect(options).not.toContain('Segredo');
    expect(options).not.toContain('Etiquetas');
  });

  it('uma condição avançada não se perde: mostra-se e grava-se tal como está', async () => {
    const advanced = { op: 'in', left: { var: 'resource.desconto' }, right: { value: ['1', '2'] } };
    const updates: unknown[] = [];
    const { el, fixture } = await render([rule({ conditionAst: advanced })], {
      update: (_id: string, _v: number, body: { conditionAst: unknown }) => {
        updates.push(body.conditionAst);
        return of(rule());
      },
    });
    button(el, 'Editar')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=opaque-condition]')?.textContent).toContain('"in"');
    // remove a condição vazia por omissão (não há cláusulas) e guarda
    el.querySelector<HTMLElement>('dialog button[type=submit]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(updates).toEqual([advanced]);
  });
});
