import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { defineEntity } from '../../../core/dynamic/engine/define-entity';
import { fieldAccessFromPermissions } from '../../../core/dynamic/engine/field-state';
import { EntityAccessService } from '../../../core/dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import type { EntityRecord, RecordActions } from '../../../core/dynamic/models/entity-record.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ApprovalsApi } from '../workflows/workflows.api';
import { RecordDetailPage } from './record-detail-page';

const entity = defineEntity({
  key: 'pedido',
  scope: 'tenant',
  tenantId: 't1',
  moduleId: null,
  version: 1,
  state: 'published',
  names: { singular: 'Pedido', plural: 'Pedidos' },
  icon: 'cube',
  fields: [{ type: 'text', key: 'ref', label: 'Referência' }],
  meta: { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' },
});

const record = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  id: 'r1',
  entityKey: 'pedido',
  tenantId: 't1',
  definitionVersion: 1,
  status: 'aberto',
  state: {
    code: 'aberto',
    label: 'Aberto',
    color: 'neutral',
    category: 'INITIAL',
    editable: true,
    version: 2,
  },
  data: { ref: 'P1' },
  rowVersion: 1,
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: '',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '',
  ...over,
});

const actions: RecordActions = {
  version: 2,
  actions: [
    { code: 'iniciar', label: 'Iniciar', toLabel: 'Em curso', reasonRequired: false },
    { code: 'cancelar', label: 'Cancelar pedido', toLabel: 'Cancelado', reasonRequired: true },
  ],
};

async function render(gateway: Partial<EntityRecordsGateway>) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DynamicEntityRegistryService, useValue: { find: () => entity } },
      { provide: PermissionService, useValue: { can: () => true } },
      {
        provide: ApprovalsApi,
        useValue: {
          instancesOf: () => of([]),
          instance: () => of(null),
          submittable: () => of([]),
        },
      },
      {
        provide: EntityAccessService,
        useValue: { fieldAccess: fieldAccessFromPermissions(() => true), can: () => true },
      },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'demo' }) } },
      {
        provide: EntityRecordsGateway,
        useValue: {
          get: () => of(record()),
          audit: () => of([]),
          lookup: () => of([]),
          availableActions: () => of(actions),
          ...gateway,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RecordDetailPage);
  fixture.componentRef.setInput('entityKey', 'pedido');
  fixture.componentRef.setInput('id', 'r1');
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  return { el, settle, button };
}

describe('Detalhe do registo com máquina de estados do servidor', () => {
  it('mostra o estado do servidor e só as acções que o servidor devolve', async () => {
    const { el } = await render({});
    expect(el.querySelector('[data-testid=state-badge]')?.textContent?.trim()).toBe('Aberto');
    const labels = [...el.querySelectorAll('[data-testid=server-actions] button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(['Iniciar', 'Cancelar pedido']);
    expect(el.textContent).toContain('Passa a Em curso');
  });

  it('confirma a acção com a versão do estado (e sem motivo quando não é exigido)', async () => {
    const calls: unknown[][] = [];
    const { el, settle, button } = await render({
      transition: (...args: unknown[]) => {
        calls.push(args);
        return of(record());
      },
    });
    button('Iniciar')!.click();
    await settle();
    expect(el.querySelector('dialog[open]')?.textContent).toContain('Em curso');
    const confirm = [...el.querySelectorAll('dialog[open] button')].find(
      (b) => b.textContent?.trim() === 'Confirmar',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await settle();
    expect(calls).toEqual([['pedido', 'r1', 'iniciar', { expectedVersion: 2, reason: undefined }]]);
    expect(el.textContent).toContain('Iniciar: concluído.');
  });

  it('o motivo é obrigatório quando a transição o exige', async () => {
    const calls: unknown[][] = [];
    const { el, settle, button } = await render({
      transition: (...args: unknown[]) => {
        calls.push(args);
        return of(record());
      },
    });
    button('Cancelar pedido')!.click();
    await settle();
    const confirm = () =>
      [...el.querySelectorAll('dialog[open] button')].find(
        (b) => b.textContent?.trim() === 'Confirmar',
      ) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    const area = el.querySelector<HTMLTextAreaElement>('dialog textarea')!;
    area.value = 'Pedido duplicado';
    area.dispatchEvent(new Event('input'));
    await settle();
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await settle();
    expect(calls[0]).toEqual([
      'pedido',
      'r1',
      'cancelar',
      { expectedVersion: 2, reason: 'Pedido duplicado' },
    ]);
  });

  it('um conflito do servidor mostra o motivo e não deixa a acção a meio', async () => {
    const { el, settle, button } = await render({
      transition: () =>
        throwError(() => ({
          status: 409,
          code: 'TRANSITION_GUARD_FAILED',
          message: 'Os dados actuais do registo não satisfazem a condição desta transição.',
        })),
    });
    button('Iniciar')!.click();
    await settle();
    (
      [...el.querySelectorAll('dialog[open] button')].find(
        (b) => b.textContent?.trim() === 'Confirmar',
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(el.textContent).toContain('não satisfazem a condição');
  });

  it('um estado que não admite alterações esconde «Editar»; sem máquina no servidor não há acções do servidor', async () => {
    const locked = await render({
      get: () =>
        of(
          record({
            state: {
              code: 'concluido',
              label: 'Concluído',
              color: 'success',
              category: 'FINAL',
              editable: false,
              version: 5,
            },
          }),
        ),
      availableActions: () => of({ version: 5, actions: [] }),
    });
    expect(
      [...locked.el.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Editar'),
    ).toBe(false);
    expect(locked.el.querySelector('[data-testid=server-actions]')).toBeNull();
  });
});
