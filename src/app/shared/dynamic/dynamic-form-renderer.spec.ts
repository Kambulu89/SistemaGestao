import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import { fieldAccessFromPermissions } from '../../core/dynamic/engine/field-state';
import { defineEntity } from '../../core/dynamic/engine/define-entity';
import type { EntityDefinition } from '../../core/dynamic/models/entity-definition.model';
import type { RecordData } from '../../core/dynamic/models/entity-record.model';
import type { FormMode } from '../../core/dynamic/models/form-definition.model';
import type { ValidationIssue } from '../../core/dynamic/models/validation-issue.model';
import { DRIVER_V1, NOTE_V1, VEHICLE_V2 } from '../../core/mock/mock-entities';
import { DynamicFormRenderer } from './dynamic-form-renderer';

@Component({
  imports: [DynamicFormRenderer],
  template: `
    <app-dynamic-form
      [entity]="entity()"
      [mode]="mode()"
      [value]="value()"
      [status]="status()"
      [issues]="issues()"
      [access]="access()"
      (submitted)="submitted.push($event)"
      (cancelled)="cancelled = cancelled + 1"
    />
  `,
})
class Host {
  readonly entity = signal<EntityDefinition>(VEHICLE_V2);
  readonly mode = signal<FormMode>('create');
  readonly value = signal<RecordData | null>(null);
  readonly status = signal<string | null>(null);
  readonly issues = signal<readonly ValidationIssue[]>([]);
  readonly access = signal(fieldAccessFromPermissions(() => true));
  readonly submitted: RecordData[] = [];
  cancelled = 0;
}

const LOOKUP = [
  { id: 'veh-1', label: 'AA-11-BB' },
  { id: 'veh-2', label: 'CC-22-DD' },
];

async function render() {
  TestBed.configureTestingModule({
    providers: [{ provide: EntityRecordsGateway, useValue: { lookup: () => of(LOOKUP) } }],
  });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const control = (label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => {
    const lab = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    const target = lab?.htmlFor ? el.querySelector<HTMLInputElement>(`#${lab.htmlFor}`) : null;
    if (!target) throw new Error(`Sem controlo "${label}"`);
    return target;
  };
  const type = async (label: string, value: string) => {
    const input = control(label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    input.dispatchEvent(new Event('blur'));
    await settle();
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle();
  };
  return { fixture, host: fixture.componentInstance, el, control, type, submit, settle };
}

describe('DynamicFormRenderer: Viatura (sem componente específico)', () => {
  it('generates the sections and fields from the definition', async () => {
    const { el } = await render();
    expect([...el.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toEqual([
      'Identificação',
      'Características',
    ]);
    const labels = [...el.querySelectorAll('label')].map((l) =>
      l.textContent?.replace('*', '').trim(),
    );
    expect(labels).toEqual([
      'Matrícula',
      'Marca',
      'Modelo',
      'Combustível',
      'Quilometragem',
      'Nº de chassis',
    ]);
  });

  it('marks required fields and applies the default mileage', async () => {
    const { el, control } = await render();
    expect(control('Matrícula').getAttribute('aria-required')).toBe('true');
    expect(control('Modelo').getAttribute('aria-required')).toBeNull();
    expect((control('Quilometragem') as HTMLInputElement).value).toBe('0');
    expect(el.querySelectorAll('select option').length).toBe(5); // vazio + 4 combustíveis
  });

  it('does not submit an invalid form and shows the errors', async () => {
    const { host, el, submit } = await render();
    await submit();
    expect(host.submitted).toEqual([]);
    expect(
      [...el.querySelectorAll('p')].filter((p) => p.textContent?.trim() === 'Campo obrigatório.'),
    ).toHaveLength(2); // matrícula e marca
  });

  it('shows the declared custom message for negative mileage', async () => {
    const { el, type } = await render();
    await type('Quilometragem', '-3');
    expect(el.textContent).toContain('A quilometragem não pode ser negativa.');
  });

  it('submits a typed payload once valid', async () => {
    const { host, type, submit } = await render();
    await type('Matrícula', 'AA-11-BB');
    await type('Marca', 'Volvo');
    await type('Combustível', 'gasoleo');
    await type('Quilometragem', '1500');
    await submit();
    expect(host.submitted).toEqual([
      {
        matricula: 'AA-11-BB',
        marca: 'Volvo',
        modelo: null,
        combustivel: 'gasoleo',
        quilometragem: 1500,
        numeroChassis: null,
      },
    ]);
  });

  it('emits cancel', async () => {
    const { host, el, settle } = await render();
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Cancelar'))?.click();
    await settle();
    expect(host.cancelled).toBe(1);
  });

  it('edits a record created before a field existed (v1 → v2) without losing data', async () => {
    const { host, control, submit, settle } = await render();
    host.mode.set('edit');
    host.value.set({
      matricula: 'OLD-01',
      marca: 'Mercedes',
      modelo: 'Actros',
      combustivel: 'gasoleo',
      quilometragem: 90000,
    });
    await settle();
    expect((control('Matrícula') as HTMLInputElement).value).toBe('OLD-01');
    expect((control('Nº de chassis') as HTMLInputElement).value).toBe('');
    await submit();
    expect(host.submitted[0]).toMatchObject({
      matricula: 'OLD-01',
      quilometragem: 90000,
      numeroChassis: null,
    });
  });

  it('read mode shows formatted values and no inputs or buttons', async () => {
    const { host, el, settle } = await render();
    host.mode.set('read');
    host.value.set({
      matricula: 'AA-11-BB',
      marca: 'Volvo',
      combustivel: 'eletrico',
      quilometragem: 12500,
    });
    await settle();
    expect(el.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(el.textContent).toContain('Eléctrico');
    expect(el.textContent).toMatch(/12\s?500/);
    expect(el.querySelectorAll('dt')).toHaveLength(6);
  });

  it('shows server errors next to the field and form-level ones in an alert', async () => {
    const { host, el, type, settle } = await render();
    await type('Matrícula', 'AA-11-BB');
    host.issues.set([
      {
        fieldKey: 'matricula',
        rule: 'unique',
        message: 'Já existe uma viatura com esta matrícula.',
      },
      { fieldKey: null, rule: 'server', message: 'O registo foi alterado por outro utilizador.' },
    ]);
    await settle();
    expect(el.textContent).toContain('Já existe uma viatura com esta matrícula.');
    expect(el.querySelector('[role=alert]')?.textContent).toContain(
      'O registo foi alterado por outro utilizador.',
    );
    await type('Matrícula', 'ZZ-99-ZZ'); // editar limpa o erro do servidor
    expect(el.textContent).not.toContain('Já existe uma viatura');
  });
});

describe('DynamicFormRenderer: a segunda entidade usa o mesmo componente', () => {
  it('Condutor: conditional field is hidden, then required for heavy categories', async () => {
    const { host, el, type, submit, settle, control } = await render();
    host.entity.set(DRIVER_V1);
    await settle();
    expect(
      [...el.querySelectorAll('label')].some((l) => l.textContent?.includes('Nº do CAP')),
    ).toBe(false);

    await type('Nome', 'Rui');
    await type('Nº da carta', '123');
    await type('Categoria', 'C');
    await type('Validade da carta', '2030-05-01');
    expect(control('Nº do CAP').getAttribute('aria-required')).toBe('true');

    await submit();
    expect(host.submitted).toEqual([]);
    expect(el.textContent).toContain('Campo obrigatório.');

    await type('Nº do CAP', 'CAP-77');
    await submit();
    expect(host.submitted[0]).toMatchObject({
      nome: 'Rui',
      categoria: 'C',
      numeroCap: 'CAP-77',
      validadeCarta: '2030-05-01',
    });
  });

  it('Condutor: category B does not need the CAP and does not send it', async () => {
    const { host, type, submit, settle } = await render();
    host.entity.set(DRIVER_V1);
    await settle();
    await type('Nome', 'Ana');
    await type('Nº da carta', '9');
    await type('Categoria', 'B');
    await type('Validade da carta', '2031-01-01');
    await submit();
    expect(host.submitted).toHaveLength(1);
    expect('numeroCap' in host.submitted[0]!).toBe(false);
  });

  it('Condutor: validates implicit email format and loads reference options', async () => {
    const { host, el, type, settle } = await render();
    host.entity.set(DRIVER_V1);
    await settle();
    await type('Email', 'nope');
    expect(el.textContent).toContain('Introduza um email válido.');
    const options = [...el.querySelectorAll('select option')].map((o) => o.textContent?.trim());
    expect(options).toContain('AA-11-BB');
    expect(options).toContain('CC-22-DD');
  });

  it('Nota (global, no declared form): generates a form with every field type', async () => {
    const { host, el, settle, control } = await render();
    host.entity.set(NOTE_V1);
    await settle();
    expect(el.querySelector('textarea')).not.toBeNull();
    expect(el.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(el.querySelector('input[type=date]')).not.toBeNull();
    expect((control('Prioridade') as HTMLSelectElement).value).toBe('media');
  });
});

describe('DynamicFormRenderer: permissions and robustness', () => {
  const secret = defineEntity({
    key: 'secret',
    tenantId: 't',
    names: { singular: 'Segredo', plural: 'Segredos' },
    icon: 'lock',
    fields: [
      { type: 'text', key: 'publico', label: 'Público' },
      {
        type: 'text',
        key: 'salario',
        label: 'Salário',
        required: true,
        permissions: { read: 'hr.read', write: 'hr.write' },
      },
    ],
  });

  it('hides fields the user may not read (and does not require them)', async () => {
    const { host, el, settle, submit, type } = await render();
    host.access.set(fieldAccessFromPermissions(() => false));
    host.entity.set(secret);
    await settle();
    expect([...el.querySelectorAll('label')].some((l) => l.textContent?.includes('Salário'))).toBe(
      false,
    );
    await type('Público', 'x');
    await submit();
    expect(host.submitted).toEqual([{ publico: 'x' }]);
  });

  it('disables fields the user may read but not write', async () => {
    const { host, control, settle } = await render();
    host.access.set(fieldAccessFromPermissions((p) => p === 'hr.read'));
    host.entity.set(secret);
    await settle();
    expect(control('Salário').hasAttribute('disabled')).toBe(true);
  });

  it('rebuilds when the entity changes, without carrying values over', async () => {
    const { host, type, settle, control } = await render();
    await type('Matrícula', 'AA-11-BB');
    host.entity.set(secret);
    await settle();
    host.entity.set(VEHICLE_V2);
    await settle();
    expect((control('Matrícula') as HTMLInputElement).value).toBe('');
  });
});

describe('DynamicFormRenderer: formulário publicado do tenant', () => {
  const entity = defineEntity({
    key: 'pedido',
    tenantId: 't',
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
      { type: 'text', key: 'motivo', label: 'Motivo' },
      { type: 'text', key: 'interno', label: 'Nota interna' },
    ],
    forms: [
      {
        key: 'ficha',
        name: 'Ficha',
        modes: ['create', 'edit', 'read'],
        isDefault: true,
        state: 'published',
        sections: [
          {
            key: 'dados',
            title: 'Dados do pedido',
            columns: 2,
            items: [
              { kind: 'field', field: 'descricao', label: 'Resumo', help: 'O que é preciso fazer' },
              { kind: 'field', field: 'prioridade' },
            ],
          },
          {
            key: 'urgencia',
            title: 'Urgência',
            columns: 1,
            visibleWhen: { op: 'eq', field: 'prioridade', value: 'alta' },
            items: [{ kind: 'field', field: 'motivo' }],
          },
        ],
      },
    ],
  });

  async function renderForm() {
    const view = await render();
    view.host.entity.set(entity);
    await view.settle();
    return view;
  }

  it('shows the form labels and help, hides what the form leaves out, and follows its conditions', async () => {
    const { el, host, type, settle } = await renderForm();
    const headings = () => [...el.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings()).toEqual(['Dados do pedido']);
    expect(el.textContent).toContain('Resumo');
    expect(el.textContent).toContain('O que é preciso fazer');
    expect(el.textContent).not.toContain('Nota interna');
    expect(el.textContent).not.toContain('Motivo');

    await type('Prioridade', 'alta');
    expect(headings()).toEqual(['Dados do pedido', 'Urgência']);
    expect(el.textContent).toContain('Motivo');

    await type('Resumo', 'Trocar fechadura');
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle();
    // Só segue o que o formulário mostra (a nota interna nunca é enviada).
    expect(host.submitted[0]).toMatchObject({ descricao: 'Trocar fechadura', prioridade: 'alta' });
    expect(Object.keys(host.submitted[0]!)).not.toContain('interno');
  });
});
