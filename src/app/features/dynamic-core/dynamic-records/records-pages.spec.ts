import { type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { EntityRecordsGateway } from '../../../core/dynamic/data-access/entity-records.gateway';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { RecordDetailPage } from './record-detail-page';
import { RecordFormPage } from './record-form-page';
import { RecordsListPage } from './records-list-page';

async function enter(email: string, slug: string): Promise<void> {
  await loginAs(email);
  await firstValueFrom(TestBed.inject(TenantContextService).activate(slug));
  await firstValueFrom(TestBed.inject(DynamicEntityRegistryService).ensureLoaded());
}

async function page<T>(
  component: Type<T>,
  inputs: Record<string, unknown>,
  ready?: (el: HTMLElement) => boolean,
) {
  const fixture: ComponentFixture<T> = TestBed.createComponent(component);
  for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async (done: (el: HTMLElement) => boolean = () => true) =>
    vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(done(el), el.textContent ?? '').toBe(true);
      },
      { timeout: 3000 },
    );
  await settle(ready);
  return { fixture, el, settle };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const rows = (el: HTMLElement) => el.querySelectorAll('tbody tr');
const type = (el: HTMLElement, label: string, value: string) => {
  const lab = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  const input = el.querySelector<HTMLInputElement>(`#${lab?.htmlFor}`)!;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  input.dispatchEvent(new Event('blur'));
};

describe('RecordsListPage: Viaturas geradas só por metadados', () => {
  beforeEach(() => setupMockBackend());

  it('lists vehicles with pagination, columns, status and search/filters', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordsListPage, { entityKey: 'vehicle' }, (e) => rows(e).length > 0);
    expect(el.querySelector('h1')?.textContent).toBe('Viaturas');
    expect(rows(el)).toHaveLength(8);
    expect(el.textContent).toContain('1–8 de 12');
    expect([...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toContain(
      'Combustível',
    );
    expect(el.querySelector<HTMLInputElement>('input[type=search]')?.placeholder).toBe(
      'Pesquisar por matrícula e marca',
    );
    expect(el.querySelector('select#dyn-filter-status')).not.toBeNull();
    expect([...el.querySelectorAll('a')].some((a) => a.textContent?.includes('Novo'))).toBe(true);
  });

  it('searches and filters through the backend', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el, settle } = await page(
      RecordsListPage,
      { entityKey: 'vehicle' },
      (e) => rows(e).length > 0,
    );

    const search = el.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'volvo';
    search.dispatchEvent(new Event('input'));
    await settle((e) => rows(e).length === 2);
    expect(el.textContent).toContain('1–2 de 2');

    const select = el.querySelector<HTMLSelectElement>('select#dyn-filter-status')!;
    select.value = 'maintenance';
    select.dispatchEvent(new Event('change'));
    await settle((e) => e.textContent!.includes('Sem resultados'));
  });

  it('offers Delete only where RBAC and the ABAC policy allow (inactive vehicles, admin)', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordsListPage, { entityKey: 'vehicle' }, (e) => rows(e).length > 0);
    const deletable = [...el.querySelectorAll('button[aria-label^="Eliminar"]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(deletable).toEqual(['Eliminar viatura II-55-JJ']);
  });

  it('never offers Delete or Create to an operator', async () => {
    await enter('operador@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordsListPage, { entityKey: 'vehicle' }, (e) => rows(e).length > 0);
    expect(el.querySelector('button[aria-label^="Eliminar"]')).toBeNull();
    expect(el.querySelector('button[aria-label^="Editar"]')).not.toBeNull();

    const drivers = await page(RecordsListPage, { entityKey: 'driver' }, (e) => rows(e).length > 0);
    expect(drivers.el.querySelector('button[aria-label^="Editar"]')).toBeNull(); // só lê condutores
    expect([...drivers.el.querySelectorAll('a')].some((a) => a.textContent?.includes('Novo'))).toBe(
      false,
    );
  });

  it('confirms and deletes a record', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el, settle } = await page(
      RecordsListPage,
      { entityKey: 'vehicle' },
      (e) => rows(e).length > 0,
    );
    el.querySelector<HTMLButtonElement>('button[aria-label="Eliminar viatura II-55-JJ"]')?.click();
    await settle((e) => e.querySelector('dialog[open]') !== null);
    expect(el.querySelector('dialog')?.textContent).toContain('II-55-JJ');

    [...el.querySelectorAll<HTMLButtonElement>('dialog button')]
      .find((b) => b.textContent?.trim() === 'Eliminar')
      ?.click();
    await settle(
      (e) => e.textContent!.includes('eliminado.') && e.textContent!.includes('1–8 de 11'),
    );
  });

  it('shows "not found" for an unknown entity', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordsListPage, { entityKey: 'ghost' });
    expect(el.textContent).toContain('Entidade não encontrada');
  });
});

describe('RecordsListPage: a mesma página serve outra entidade e outro tenant', () => {
  beforeEach(() => setupMockBackend());

  it('Escola lists its own notes (global entity) and cannot see vehicles', async () => {
    await enter('escola@demo.pt', 'escola-horizonte');
    const notes = await page(RecordsListPage, { entityKey: 'note' }, (e) => rows(e).length > 0);
    expect(notes.el.querySelector('h1')?.textContent).toBe('Notas');
    expect(rows(notes.el)).toHaveLength(3);
    expect(notes.el.textContent).toContain('Reunião de pais');
    expect(notes.el.textContent).not.toContain('Renovar seguro'); // nota da Atlas

    const vehicles = await page(RecordsListPage, { entityKey: 'vehicle' });
    expect(vehicles.el.textContent).toContain('Entidade não encontrada');
  });

  it('Condutores resolves the vehicle reference label', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordsListPage, { entityKey: 'driver' }, (e) =>
      e.textContent!.includes('AA-11-BB'),
    );
    expect(rows(el)).toHaveLength(4);
    expect(el.textContent).toContain('Rui Carvalho');
    expect(el.textContent).toContain('KK-66-LL');
  });
});

describe('RecordFormPage', () => {
  beforeEach(() => setupMockBackend());

  it('creates a vehicle and goes to its detail', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { el, settle } = await page(RecordFormPage, { entityKey: 'vehicle' });
    expect(el.querySelector('h1')?.textContent).toBe('Criar viatura');

    type(el, 'Matrícula', 'ZZ-00-ZZ');
    type(el, 'Marca', 'Volvo');
    type(el, 'Combustível', 'gasoleo');
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle(() => navigate.mock.calls.length > 0);

    const [path] = navigate.mock.calls[0]!;
    expect(path.slice(0, 4)).toEqual(['/t', 'transportes-atlas', 'data', 'vehicle']);
    const api = TestBed.inject(EntityRecordsGateway);
    expect((await firstValueFrom(api.list('vehicle', { page: 1, pageSize: 20 }))).total).toBe(13);
  });

  it('maps a 422 from the server back to the field and does not navigate', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { el, settle } = await page(RecordFormPage, { entityKey: 'vehicle' });

    type(el, 'Matrícula', 'AA-11-BB'); // já existe: só o servidor sabe
    type(el, 'Marca', 'Volvo');
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle((e) => e.textContent!.includes('Já existe uma viatura com esta matrícula.'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('edits a record, sending the version it loaded', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { el, settle } = await page(
      RecordFormPage,
      { entityKey: 'vehicle', id: 'vehicle-1' },
      (e) => e.querySelector('h1')?.textContent === 'Editar AA-11-BB',
    );
    type(el, 'Quilometragem', '13000');
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle(() => navigate.mock.calls.length > 0);
    const saved = await firstValueFrom(
      TestBed.inject(EntityRecordsGateway).get('vehicle', 'vehicle-1'),
    );
    expect(saved).toMatchObject({ rowVersion: 2, data: { quilometragem: 13000 } });
  });

  it('shows a concurrency conflict when someone else saved first', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el, settle } = await page(
      RecordFormPage,
      { entityKey: 'vehicle', id: 'vehicle-1' },
      (e) => e.querySelector('h1')?.textContent === 'Editar AA-11-BB',
    );
    await firstValueFrom(
      TestBed.inject(EntityRecordsGateway).update('vehicle', 'vehicle-1', {
        data: { quilometragem: 1 },
        expectedRowVersion: 1,
      }),
    );

    type(el, 'Quilometragem', '2');
    el.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
    await settle(
      (e) =>
        e.querySelector('[role=alert]')?.textContent?.includes('alterado por outro utilizador') ===
        true,
    );
  });

  it('the same page creates a driver, including the conditional rule', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el, settle } = await page(RecordFormPage, { entityKey: 'driver' });
    const hasCap = (e: HTMLElement) =>
      [...e.querySelectorAll('label')].some((l) => l.textContent?.includes('Nº do CAP'));

    expect(el.querySelector('h1')?.textContent).toBe('Criar condutor');
    expect(hasCap(el)).toBe(false);
    type(el, 'Categoria', 'D');
    await settle(hasCap); // o campo aparece quando a condição passa a verificar-se
  });
});

describe('RecordDetailPage', () => {
  beforeEach(() => setupMockBackend());

  it('shows the record, status, history and only the allowed actions', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordDetailPage, { entityKey: 'vehicle', id: 'vehicle-1' }, (e) =>
      e.textContent!.includes('Criado'),
    );
    expect(el.querySelector('h1')?.textContent).toBe('AA-11-BB');
    expect(el.textContent).toContain('Disponível');
    expect(el.textContent).toContain('Volvo');
    expect(el.textContent).toContain('YV2RT40A9KB123456');
    expect([...el.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Editar')).toBe(
      true,
    );
    expect(button(el, 'Eliminar')).toBeUndefined(); // ABAC: só inactivas
  });

  it('shows "—" for a field added after the record was created (v1 → v2)', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(RecordDetailPage, { entityKey: 'vehicle', id: 'vehicle-2' }, (e) =>
      e.textContent!.includes('Scania'),
    );
    const chassis = [...el.querySelectorAll('dt')].find((d) => d.textContent === 'Nº de chassis');
    expect(chassis?.nextElementSibling?.textContent?.trim()).toBe('—');
  });

  it('runs a workflow transition and records it in the history', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el, settle } = await page(
      RecordDetailPage,
      { entityKey: 'vehicle', id: 'vehicle-1' },
      (e) => !!button(e, 'Enviar para manutenção'),
    );
    button(el, 'Enviar para manutenção')?.click();
    await settle(
      (e) =>
        e.textContent!.includes('Em manutenção') &&
        e.textContent!.includes('Estado: Disponível → Em manutenção'),
    );
    expect(el.textContent).toContain('Mudança de estado');
    expect(button(el, 'Concluir manutenção')).toBeDefined(); // as transições mudam com o estado
    expect(button(el, 'Enviar para manutenção')).toBeUndefined();
  });

  it('shows approval-gated transitions disabled for an operator, and executable ones enabled', async () => {
    await enter('operador@demo.pt', 'transportes-atlas');
    const { el } = await page(
      RecordDetailPage,
      { entityKey: 'vehicle', id: 'vehicle-1' },
      (e) => !!button(e, 'Desactivar'),
    );
    expect(button(el, 'Desactivar')?.disabled).toBe(true);
    expect(el.textContent).toContain('Requer aprovação');
    expect(button(el, 'Enviar para manutenção')?.disabled).toBe(false);
  });

  it('lets the user delete an inactive vehicle and returns to the list', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { el, settle } = await page(
      RecordDetailPage,
      { entityKey: 'vehicle', id: 'vehicle-5' },
      (e) => !!button(e, 'Eliminar'),
    );
    button(el, 'Eliminar')?.click();
    await settle((e) => e.querySelector('dialog[open]') !== null);
    [...el.querySelectorAll<HTMLButtonElement>('dialog button')]
      .find((b) => b.textContent?.trim() === 'Eliminar')
      ?.click();
    await settle(() => navigate.mock.calls.length > 0);
    expect(navigate).toHaveBeenCalledWith(['/t', 'transportes-atlas', 'data', 'vehicle']);
  });

  it('shows an error when the record belongs to another tenant (404, no leak)', async () => {
    await enter('frota@demo.pt', 'transportes-atlas');
    const { el } = await page(
      RecordDetailPage,
      { entityKey: 'note', id: 'note-3' },
      (e) => e.querySelector('[role=alert]') !== null,
    );
    expect(el.textContent).toContain('Registo não encontrado.');
  });
});
