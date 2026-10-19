import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import { defineEntity } from '../../core/dynamic/engine/define-entity';
import { fieldAccessFromPermissions } from '../../core/dynamic/engine/field-state';
import { mergeCustomFields } from '../../core/dynamic/engine/custom-fields';
import type { RecordData } from '../../core/dynamic/models/entity-record.model';
import { CUSTOMER_V1 } from '../../core/mock/mock-entities';
import { MOCK_CUSTOM_FIELDS } from '../../core/mock/mock-custom-fields';
import { DynamicFormRenderer } from './dynamic-form-renderer';

const ENTITY = defineEntity({
  key: 'equipamento',
  scope: 'tenant',
  tenantId: 't-x',
  moduleId: null,
  version: 1,
  names: { singular: 'Equipamento', plural: 'Equipamentos' },
  icon: 'box',
  fields: [
    { type: 'text', key: 'designacao', label: 'Designação', required: true },
    { type: 'url', key: 'site', label: 'Site' },
    { type: 'checkbox', key: 'aceito', label: 'Aceito os termos', required: true },
    {
      type: 'radio',
      key: 'estado',
      label: 'Estado',
      options: [
        { value: 'novo', label: 'Novo' },
        { value: 'usado', label: 'Usado' },
        { value: 'velho', label: 'Antigo', active: false },
      ],
    },
    {
      type: 'select',
      key: 'tipo',
      label: 'Tipo',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', active: false },
      ],
    },
    { type: 'image', key: 'foto', label: 'Foto' },
    {
      type: 'auto-number',
      key: 'codigo',
      label: 'Código',
      autoNumber: { prefix: 'EQ-', padding: 4, start: 1, reset: 'never' },
    },
    { type: 'user-reference', key: 'responsavel', label: 'Responsável' },
  ],
  list: { columns: [{ field: 'designacao' }] },
});

@Component({
  imports: [DynamicFormRenderer],
  template: `<app-dynamic-form
    [entity]="entity"
    mode="create"
    [value]="value()"
    [access]="access"
    (submitted)="submitted.push($event)"
  />`,
})
class Host {
  entity = ENTITY;
  readonly value = signal<RecordData | null>(null);
  readonly access = fieldAccessFromPermissions(() => true);
  readonly submitted: RecordData[] = [];
}

async function render(value: RecordData | null = null) {
  TestBed.configureTestingModule({
    providers: [{ provide: EntityRecordsGateway, useValue: { lookup: () => of([]) } }],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.value.set(value);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('Dynamic form: novos tipos de campo', () => {
  it('renders url, checkbox, radio, image and select controls', async () => {
    const { el } = await render();
    expect(el.querySelector('input[type=url]')).not.toBeNull();
    expect(el.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(el.querySelectorAll('input[type=radio]')).toHaveLength(2); // a opção inactiva não aparece
    expect(el.querySelector('input[type=file][accept="image/*"]')).not.toBeNull();
  });

  it('hides inactive options but keeps the stored one when editing old data', async () => {
    const { el } = await render({ designacao: 'X', estado: 'velho', tipo: 'b' });
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radios.map((r) => r.value)).toEqual(['novo', 'usado', 'velho']);
    expect([...el.querySelectorAll('select option')].map((o) => o.textContent?.trim())).toContain(
      'B',
    );
  });

  it('shows server-assigned types as read-only with the assigned value, and user references as a picker', async () => {
    const { el } = await render({ codigo: 'EQ-0007' });
    expect(el.querySelector('[data-testid=computed-field]')?.textContent).toContain('EQ-0007');
    const labels = [...el.querySelectorAll('label')].map((l) =>
      l.textContent?.replace('*', '').trim(),
    );
    expect(labels).toContain('Responsável'); // o selector de utilizadores
  });

  it('shows a clear notice for a type without a control instead of failing silently', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: EntityRecordsGateway, useValue: { lookup: () => of([]) } }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.entity = defineEntity({
      key: 'x',
      scope: 'tenant',
      tenantId: 't',
      names: { singular: 'X', plural: 'Xs' },
      icon: 'cube',
      fields: [{ type: 'hologram', key: 'h', label: 'Holograma' } as never],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid=unsupported-field]')?.textContent,
    ).toContain('ainda não disponível');
  });

  it('never submits server-assigned fields and requires the checkbox to be checked', async () => {
    const { fixture, el } = await render();
    const host = fixture.componentInstance;
    const text = el.querySelector<HTMLInputElement>('input[type=text]')!;
    text.value = 'Prensa';
    text.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await fixture.whenStable();
    expect(host.submitted).toEqual([]); // checkbox obrigatória por assinalar

    const box = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.click();
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await fixture.whenStable();
    expect(host.submitted).toHaveLength(1);
    expect(host.submitted[0]).not.toHaveProperty('codigo');
    expect(host.submitted[0]).toMatchObject({ designacao: 'Prensa', aceito: true });
  });

  it('renders the custom fields of a tenant inside the native Cliente form (caso A)', async () => {
    const merged = mergeCustomFields(CUSTOMER_V1, MOCK_CUSTOM_FIELDS, 't-escola');
    TestBed.configureTestingModule({
      providers: [{ provide: EntityRecordsGateway, useValue: { lookup: () => of([]) } }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.entity = merged as never;
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const labels = [...el.querySelectorAll('label, legend')].map((l) =>
      l.textContent?.replace('*', '').trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        'Nome',
        'Sector de actividade',
        'NIF secundário',
        'Categoria',
        'Data de renovação',
      ]),
    );
    expect(labels).not.toContain('Região comercial');
  });
});
