import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { Page } from '../../core/api/pagination.model';
import { EntityRecordsGateway } from '../../core/dynamic/data-access/entity-records.gateway';
import { defineEntity } from '../../core/dynamic/engine/define-entity';
import type { EntityDefinition } from '../../core/dynamic/models/entity-definition.model';
import type { EntityRecord, RecordQuery } from '../../core/dynamic/models/entity-record.model';
import { DRIVER_V1, VEHICLE_V2 } from '../../core/mock/mock-entities';
import { DynamicListRenderer } from './dynamic-list-renderer';

const record = (id: string, status: string, data: EntityRecord['data']): EntityRecord => ({
  id,
  entityKey: 'vehicle',
  tenantId: 't-atlas',
  definitionVersion: 2,
  status,
  data,
  rowVersion: 1,
  createdAt: '2026-06-01T10:00:00Z',
  createdBy: 'u',
  updatedAt: '2026-06-02T10:00:00Z',
  updatedBy: 'u',
});

const VEHICLES: Page<EntityRecord> = {
  items: [
    record('1', 'available', {
      matricula: 'AA-11-BB',
      marca: 'Volvo',
      modelo: 'FH',
      combustivel: 'gasoleo',
      quilometragem: 12500,
    }),
    record('2', 'maintenance', {
      matricula: 'CC-22-DD',
      marca: 'Scania',
      combustivel: 'hibrido',
      quilometragem: 800,
    }),
    record('3', 'inactive', {
      matricula: 'EE-33-FF',
      marca: 'MAN',
      combustivel: 'eletrico',
      quilometragem: 0,
    }),
  ],
  total: 21,
  page: 1,
  pageSize: 8,
};

const BASE_QUERY: RecordQuery = { page: 1, pageSize: 8 };

@Component({
  imports: [DynamicListRenderer],
  template: `
    <app-dynamic-list
      [entity]="entity()"
      [result]="result()"
      [loading]="loading()"
      [error]="error()"
      [query]="query()"
      [canView]="canView"
      [canEdit]="canEdit"
      [canDelete]="canDelete"
      (queryChange)="queries.push($event)"
      (view)="viewed.push($event.id)"
      (edit)="edited.push($event.id)"
      (remove)="removed.push($event.id)"
    >
      <button emptyAction type="button">Criar viatura</button>
    </app-dynamic-list>
  `,
})
class Host {
  readonly entity = signal<EntityDefinition>(VEHICLE_V2);
  readonly result = signal<Page<EntityRecord> | null>(VEHICLES);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly query = signal<RecordQuery>(BASE_QUERY);
  canView = () => true;
  canEdit = () => true;
  // ABAC: só viaturas inactivas se podem eliminar.
  canDelete = (r: EntityRecord) => r.status === 'inactive';
  readonly queries: RecordQuery[] = [];
  readonly viewed: string[] = [];
  readonly edited: string[] = [];
  readonly removed: string[] = [];
}

async function render(lookup = () => of([] as { id: string; label: string }[])) {
  const lookupSpy = vi.fn(lookup);
  TestBed.configureTestingModule({
    providers: [{ provide: EntityRecordsGateway, useValue: { lookup: lookupSpy } }],
  });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, el, settle, lookupSpy };
}

const texts = (nodes: NodeListOf<Element>) => [...nodes].map((n) => n.textContent?.trim());

describe('DynamicListRenderer: Viatura (sem componente específico)', () => {
  it('generates the columns from the definition', async () => {
    const { el } = await render();
    expect(texts(el.querySelectorAll('thead th'))).toEqual([
      'Matrícula',
      'Marca',
      'Modelo',
      'Combustível',
      'Quilometragem',
      'Estado',
      'Acções',
    ]);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('formats cells by field type and shows the status as a badge', async () => {
    const { el } = await render();
    const first = el.querySelector('tbody tr')!;
    expect(first.textContent).toContain('AA-11-BB');
    expect(first.textContent).toContain('Gasóleo'); // rótulo da opção, não o valor guardado
    expect(first.textContent).toMatch(/12\s?500/);
    expect(first.textContent).toContain('Disponível');
    expect(el.textContent).toContain('Em manutenção');
    expect(el.querySelectorAll('tbody tr')[1]!.textContent).toContain('—'); // sem modelo
  });

  it('offers search and filters declared by the metadata', async () => {
    const { el } = await render();
    expect(el.querySelector<HTMLInputElement>('input[type=search]')?.placeholder).toBe(
      'Pesquisar por matrícula e marca',
    );
    expect(texts(el.querySelectorAll('select#dyn-filter-combustivel option'))).toEqual([
      'Todos',
      'Gasolina',
      'Gasóleo',
      'Eléctrico',
      'Híbrido',
    ]);
    expect(texts(el.querySelectorAll('select#dyn-filter-status option'))).toEqual([
      'Todos',
      'Disponível',
      'Em manutenção',
      'Inactiva',
    ]);
  });

  it('emits the search after a debounce, trimmed and back on page 1', async () => {
    const { host, el, fixture } = await render();
    host.query.set({ ...BASE_QUERY, page: 3 });
    fixture.detectChanges();
    vi.useFakeTimers();
    try {
      const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
      input.value = '  volvo ';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(100);
      expect(host.queries).toEqual([]); // ainda dentro do debounce
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    expect(host.queries).toEqual([{ page: 1, pageSize: 8, search: 'volvo' }]);
  });

  it('emits filters (page 1) and removes one when "Todos" is chosen', async () => {
    const { host, el, settle } = await render();
    const select = el.querySelector<HTMLSelectElement>('select#dyn-filter-combustivel')!;
    select.value = 'gasoleo';
    select.dispatchEvent(new Event('change'));
    expect(host.queries.at(-1)).toEqual({
      page: 1,
      pageSize: 8,
      filters: { combustivel: 'gasoleo' },
    });

    host.query.set({
      page: 2,
      pageSize: 8,
      filters: { combustivel: 'gasoleo', status: 'available' },
    });
    await settle();
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(host.queries.at(-1)).toEqual({ page: 1, pageSize: 8, filters: { status: 'available' } });
  });

  it('emits sorting and pagination', async () => {
    const { host, el } = await render();
    [...el.querySelectorAll('th button')]
      .find((b) => b.textContent?.includes('Marca'))
      ?.dispatchEvent(new Event('click'));
    expect(host.queries.at(-1)).toEqual({
      page: 1,
      pageSize: 8,
      sort: { key: 'marca', direction: 'asc' },
    });

    el.querySelector<HTMLButtonElement>('button[aria-label="Página seguinte"]')?.click();
    expect(host.queries.at(-1)).toEqual({ page: 2, pageSize: 8 });
    expect(el.textContent).toContain('1–8 de 21');
  });

  it('shows row actions only where the permission callbacks allow them (RBAC + ABAC)', async () => {
    const { host, el } = await render();
    const rows = el.querySelectorAll('tbody tr');
    expect(texts(rows[0]!.querySelectorAll('button')).length).toBe(2); // ver + editar
    expect(rows[0]!.querySelector('button[aria-label="Eliminar viatura AA-11-BB"]')).toBeNull();
    expect(rows[2]!.querySelector('button[aria-label="Eliminar viatura EE-33-FF"]')).not.toBeNull();

    rows[0]!.querySelector<HTMLButtonElement>('button[aria-label="Ver viatura AA-11-BB"]')?.click();
    rows[0]!
      .querySelector<HTMLButtonElement>('button[aria-label="Editar viatura AA-11-BB"]')
      ?.click();
    rows[2]!
      .querySelector<HTMLButtonElement>('button[aria-label="Eliminar viatura EE-33-FF"]')
      ?.click();
    expect([host.viewed, host.edited, host.removed]).toEqual([['1'], ['1'], ['3']]);
  });

  it('hides the actions column when nothing is permitted', async () => {
    const { host, el, settle } = await render();
    host.canView = () => false;
    host.canEdit = () => false;
    host.canDelete = () => false;
    host.result.set({ ...VEHICLES, items: [...VEHICLES.items] }); // nova página para reavaliar
    await settle();
    expect(texts(el.querySelectorAll('thead th'))).not.toContain('Acções');
  });
});

describe('DynamicListRenderer: estados', () => {
  it('shows loading while there is nothing to display yet', async () => {
    const { host, el, settle } = await render();
    host.result.set(null);
    host.loading.set(true);
    await settle();
    expect(el.querySelector('[role=status]')?.textContent).toContain('A carregar viaturas');
  });

  it('keeps showing the table, dimmed and busy, while reloading', async () => {
    const { host, el, settle } = await render();
    host.loading.set(true);
    await settle();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(el.querySelector('[aria-busy=true]')).not.toBeNull();
  });

  it('shows errors', async () => {
    const { host, el, settle } = await render();
    host.result.set(null);
    host.error.set('Sem ligação ao servidor.');
    await settle();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Sem ligação ao servidor.');
  });

  it('shows an empty state with the projected create action when there are no records', async () => {
    const { host, el, settle } = await render();
    host.result.set({ items: [], total: 0, page: 1, pageSize: 8 });
    await settle();
    expect(el.textContent).toContain('Ainda não há viaturas');
    expect(el.textContent).toContain('Criar viatura');
  });

  it('distinguishes "no results" from "no records" and lets the user clear', async () => {
    const { host, el, settle } = await render();
    host.result.set({ items: [], total: 0, page: 1, pageSize: 8 });
    host.query.set({ page: 1, pageSize: 8, search: 'zzz', filters: { status: 'inactive' } });
    await settle();
    expect(el.textContent).toContain('Sem resultados');
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Limpar pesquisa e filtros'))
      ?.click();
    expect(host.queries.at(-1)).toEqual({ page: 1, pageSize: 8, search: undefined, filters: {} });
  });

  it('keeps the search box in sync with the query', async () => {
    const { host, el, settle } = await render();
    host.query.set({ page: 1, pageSize: 8, search: 'volvo' });
    await settle();
    expect(el.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('volvo');
    host.query.set(BASE_QUERY);
    await settle();
    expect(el.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('');
  });
});

describe('DynamicListRenderer: outra entidade, sem código novo', () => {
  it('Condutor: resolves reference labels with ONE lookup for the whole page', async () => {
    const { host, el, settle, lookupSpy } = await render(() =>
      of([
        { id: 'veh-1', label: 'AA-11-BB' },
        { id: 'veh-2', label: 'CC-22-DD' },
      ]),
    );
    const driver = (id: string, nome: string, viatura: string | null): EntityRecord => ({
      ...record(id, '', {
        nome,
        numeroCarta: id,
        categoria: 'B',
        validadeCarta: '2030-01-01',
        viatura,
      }),
      entityKey: 'driver',
      status: null,
    });
    host.entity.set(DRIVER_V1);
    host.result.set({
      items: [
        driver('1', 'Rui', 'veh-1'),
        driver('2', 'Ana', 'veh-2'),
        driver('3', 'Rita', 'veh-1'),
        driver('4', 'Sem', null),
      ],
      total: 4,
      page: 1,
      pageSize: 8,
    });
    await settle();
    await settle();
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith('vehicle', { ids: ['veh-1', 'veh-2'] });
    const rows = el.querySelectorAll('tbody tr');
    expect(rows[0]!.textContent).toContain('AA-11-BB');
    expect(rows[1]!.textContent).toContain('CC-22-DD');
    expect(texts(el.querySelectorAll('thead th'))).toEqual([
      'Nome',
      'Nº da carta',
      'Categoria',
      'Validade da carta',
      'Viatura atribuída',
      'Acções',
    ]);
    expect(rows[0]!.textContent).toContain('B (ligeiros)');
  });

  it('an entity without searchable or filterable fields has no toolbar', async () => {
    const { host, el, settle } = await render();
    host.entity.set(
      defineEntity({
        key: 'tag',
        tenantId: 't',
        names: { singular: 'Etiqueta', plural: 'Etiquetas' },
        icon: 'tag',
        fields: [{ type: 'text', key: 'nome', label: 'Nome' }],
      }),
    );
    host.result.set({
      items: [{ ...VEHICLES.items[0]!, data: { nome: 'Urgente' } }],
      total: 1,
      page: 1,
      pageSize: 8,
    });
    await settle();
    expect(el.querySelector('[role=search]')).toBeNull();
    expect(el.textContent).toContain('Urgente');
  });
});
