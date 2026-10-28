import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import {
  InventoryApi,
  type BalanceDto,
  type MovementDto,
  type ReservationDto,
  type WarehouseDto,
} from './inventory.api';
import { InventoryPage } from './inventory-page';
import { LotsTab } from './lots-tab';
import { MovementsTab } from './movements-tab';
import { ReservationsTab } from './reservations-tab';
import { StockTab } from './stock-tab';
import { WarehousesTab } from './warehouses-tab';

const ALL = ['inventory.read', 'inventory.adjust', 'inventory.reserve', 'warehouse.manage'];

const WAREHOUSE: WarehouseDto = {
  id: 'w1',
  organizationId: 'o1',
  code: 'ARM-1',
  name: 'Central',
  allowNegative: false,
  allowBackorder: false,
  salesDefault: false,
  active: true,
  version: 3,
  locations: [
    { id: 'l1', warehouseId: 'w1', code: 'PRINCIPAL', name: 'Principal', active: true, version: 1 },
  ],
};

const BALANCE: BalanceDto = {
  id: 'b1',
  variantId: 'v1',
  locationId: 'l1',
  warehouseId: 'w1',
  lotId: null,
  lotCode: null,
  expiresOn: null,
  onHand: '10.500000',
  reserved: '3.000000',
  available: '7.500000',
};

const MOVEMENT: MovementDto = {
  id: 'm1',
  variantId: 'v1',
  locationId: 'l1',
  lotId: null,
  quantityDelta: '-4.000000',
  unitCost: '6.0000',
  sourceType: 'ADJUSTMENT',
  sourceId: 's1',
  kind: 'ADJUSTMENT',
  reversedMovementId: null,
  reason: 'Quebra',
  postedAt: '2026-10-28T10:00:00Z',
};

const RESERVATION: ReservationDto = {
  id: 'r1',
  variantId: 'v1',
  locationId: 'l1',
  lotId: null,
  sourceType: 'SALES_ORDER',
  sourceId: 'so1',
  quantity: '3.000000',
  consumedQty: '0.000000',
  releasedQty: '0.000000',
  expiresAt: null,
  status: 'ACTIVE',
};

const page = <T>(items: T[]) => ({ items, total: items.length });

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    warehouses: () => of([WAREHOUSE]),
    warehouse: () => of(WAREHOUSE),
    balances: vi.fn(() => of(page([BALANCE]))),
    movements: vi.fn(() => of(page([MOVEMENT]))),
    reservations: vi.fn(() => of(page([RESERVATION]))),
    lots: () => of([]),
    variant: () =>
      of({
        id: 'v1',
        sku: 'CAM-001',
        productName: 'Camisola',
        trackStock: true,
        trackingMode: 'NONE',
      }),
    variantBySku: () =>
      of({
        id: 'v1',
        sku: 'CAM-001',
        productName: 'Camisola',
        trackStock: true,
        trackingMode: 'NONE',
      }),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: InventoryApi, useValue: full },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: () => of([{ id: 'o1', code: 'EMP', legalName: 'Empresa' }]),
        },
      },
    ],
  });
  return full;
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const field = (label: string) => {
  const lab = [...document.body.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  );
  return document.body.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
};
const type = (label: string, value: string) => {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};
const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
const button = (label: string) => buttons(label)[0]!;
const text = () => document.body.textContent ?? '';

describe('StockTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(StockTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('mostra saldos com o nome do artigo, o local e as quantidades sem zeros inúteis', async () => {
    await open();
    expect(text()).toContain('CAM-001 — Camisola');
    expect(text()).toContain('ARM-1 / PRINCIPAL');
    expect(text()).toContain('10.5');
    expect(text()).toContain('7.5');
  });

  it('filtra por armazém no servidor', async () => {
    const { fixture, mocked } = await open();
    type('Armazém', 'w1');
    await settle(fixture);
    expect(mocked.balances).toHaveBeenLastCalledWith({ limit: 25, offset: 0, warehouseId: 'w1' });
  });

  it('pede os movimentos de uma variante', async () => {
    const { fixture } = await open();
    const emitted: string[] = [];
    fixture.componentInstance.history.subscribe((id) => emitted.push(id));
    button('Movimentos').click();
    expect(emitted).toEqual(['v1']);
  });

  it('o ajuste valida antes de enviar e envia uma referência estável', async () => {
    const adjust = vi.fn(() => of({ ...MOVEMENT, idempotent: false }));
    const { fixture } = await open({ adjust });
    button('Ajustar stock').click();
    await settle(fixture);
    button('Lançar ajuste').click();
    await settle(fixture);
    expect(adjust).not.toHaveBeenCalled();
    expect(text()).toContain('Procure primeiro a variante');
    type('SKU', 'CAM-001');
    await settle(fixture);
    button('Procurar').click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=variant-found]')?.textContent).toContain(
      'Camisola',
    );
    type('Local', 'l1');
    type('Quantidade', '-2');
    type('Motivo', 'Quebra');
    await settle(fixture);
    button('Lançar ajuste').click();
    await settle(fixture);
    expect(adjust).toHaveBeenCalledTimes(1);
    const body = (adjust.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({
      variantId: 'v1',
      locationId: 'l1',
      lotId: null,
      quantityDelta: '-2',
      unitCost: null,
      reason: 'Quebra',
    });
    expect(body['reference']).toMatch(/^[0-9a-f-]{36}$/);
    expect(text()).toContain('Ajuste lançado.');
  });

  it('mostra o erro do servidor (stock insuficiente) sem fechar o formulário', async () => {
    const adjust = vi.fn(() =>
      throwError(() => ({ code: 'INSUFFICIENT_STOCK', message: 'Stock disponível insuficiente.' })),
    );
    const { fixture } = await open({ adjust });
    button('Ajustar stock').click();
    await settle(fixture);
    type('SKU', 'CAM-001');
    await settle(fixture);
    button('Procurar').click();
    await settle(fixture);
    type('Local', 'l1');
    type('Quantidade', '-99');
    type('Motivo', 'Quebra');
    await settle(fixture);
    button('Lançar ajuste').click();
    await settle(fixture);
    expect(text()).toContain('Stock disponível insuficiente.');
    expect(button('Lançar ajuste')).toBeTruthy();
  });

  it('um produto com lotes exige o lote', async () => {
    const adjust = vi.fn(() => of({ ...MOVEMENT, idempotent: false }));
    const { fixture } = await open({
      adjust,
      variantBySku: () =>
        of({
          id: 'v2',
          sku: 'IOG-1',
          productName: 'Iogurte',
          trackStock: true,
          trackingMode: 'LOT',
        }),
      lots: () =>
        of([
          {
            id: 'lot1',
            variantId: 'v2',
            code: 'L1',
            manufacturedOn: null,
            expiresOn: '2099-01-01',
          },
        ]),
    });
    button('Ajustar stock').click();
    await settle(fixture);
    type('SKU', 'IOG-1');
    await settle(fixture);
    button('Procurar').click();
    await settle(fixture);
    type('Local', 'l1');
    type('Quantidade', '5');
    type('Motivo', 'Contagem');
    await settle(fixture);
    button('Lançar ajuste').click();
    await settle(fixture);
    expect(adjust).not.toHaveBeenCalled();
    expect(text()).toContain('escolha o lote');
    type('Lote', 'lot1');
    await settle(fixture);
    button('Lançar ajuste').click();
    await settle(fixture);
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it('sem inventory.adjust não há ajuste', async () => {
    await open({}, ['inventory.read']);
    expect(buttons('Ajustar stock')).toHaveLength(0);
  });
});

describe('MovementsTab', () => {
  async function open(
    api: Record<string, unknown> = {},
    granted?: readonly string[],
    variantId: string | null = null,
  ) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(MovementsTab);
    fixture.componentRef.setInput('filterVariantId', variantId);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('mostra o sinal e a origem, e filtra pela variante', async () => {
    const { mocked } = await open({}, undefined, 'v1');
    expect(text()).toContain('-4');
    expect(text()).toContain('Ajuste manual');
    expect(text()).toContain('Quebra');
    expect(mocked.movements).toHaveBeenCalledWith({ limit: 25, offset: 0, variantId: 'v1' });
    expect(document.body.querySelector('[data-testid=movement-filter]')?.textContent).toContain(
      'CAM-001',
    );
  });

  it('reverte com motivo e avisa quando já estava revertido', async () => {
    const reverse = vi
      .fn()
      .mockReturnValueOnce(of({ ...MOVEMENT, idempotent: false }))
      .mockReturnValueOnce(of({ ...MOVEMENT, idempotent: true }));
    const { fixture } = await open({ reverse });
    button('Reverter').click();
    await settle(fixture);
    [...buttons('Reverter')].at(-1)!.click();
    await settle(fixture);
    expect(reverse).not.toHaveBeenCalled();
    expect(text()).toContain('Indique o motivo');
    type('Motivo', 'Entrada em duplicado');
    await settle(fixture);
    [...buttons('Reverter')].at(-1)!.click();
    await settle(fixture);
    expect(reverse).toHaveBeenCalledWith('m1', 'Entrada em duplicado');
    expect(text()).toContain('Movimento revertido.');
  });

  it('uma reversão não tem botão de reverter e sem inventory.adjust não há reverter', async () => {
    await open({ movements: () => of(page([{ ...MOVEMENT, kind: 'REVERSAL' }])) });
    expect(buttons('Reverter')).toHaveLength(0);
    TestBed.resetTestingModule();
    await open({}, ['inventory.read']);
    expect(buttons('Reverter')).toHaveLength(0);
  });
});

describe('ReservationsTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(ReservationsTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('lista e liberta uma reserva activa', async () => {
    const release = vi.fn(() => of({ ...RESERVATION, status: 'RELEASED' }));
    const { fixture } = await open({ release });
    expect(text()).toContain('Encomenda de venda');
    expect(text()).toContain('Activa');
    button('Libertar').click();
    await settle(fixture);
    expect(release).toHaveBeenCalledWith('r1');
    expect(text()).toContain('Reserva libertada.');
  });

  it('só reservas activas têm «Libertar»; sem inventory.reserve não há acções', async () => {
    await open({ reservations: () => of(page([{ ...RESERVATION, status: 'CONSUMED' }])) });
    expect(buttons('Libertar')).toHaveLength(0);
    TestBed.resetTestingModule();
    await open({}, ['inventory.read']);
    expect(buttons('Libertar')).toHaveLength(0);
    expect(buttons('Libertar vencidas')).toHaveLength(0);
  });

  it('filtra por estado e liberta as vencidas', async () => {
    const expireReservations = vi.fn(() => of({ expired: 2 }));
    const { fixture, mocked } = await open({ expireReservations });
    type('Estado', 'ACTIVE');
    await settle(fixture);
    expect(mocked.reservations).toHaveBeenLastCalledWith({
      limit: 25,
      offset: 0,
      status: 'ACTIVE',
    });
    button('Libertar vencidas').click();
    await settle(fixture);
    expect(text()).toContain('2 reserva(s) vencida(s) libertada(s).');
  });

  it('mostra o erro do servidor ao libertar', async () => {
    const release = vi.fn(() =>
      throwError(() => ({ code: 'NOT_FOUND', message: 'Recurso não encontrado.' })),
    );
    const { fixture } = await open({ release });
    button('Libertar').click();
    await settle(fixture);
    expect(text()).toContain('Recurso não encontrado.');
  });
});

describe('WarehousesTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(WarehousesTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('usa o armazém nas vendas com a versão esperada', async () => {
    const updateWarehouse = vi.fn(() => of(WAREHOUSE));
    const { fixture } = await open({ updateWarehouse });
    button('Usar nas vendas').click();
    await settle(fixture);
    expect(updateWarehouse).toHaveBeenCalledWith(WAREHOUSE, { salesDefault: true });
  });

  it('mostra as políticas e o erro quando já há um armazém de vendas', async () => {
    const updateWarehouse = vi.fn(() =>
      throwError(() => ({
        code: 'SALES_WAREHOUSE_TAKEN',
        message: 'A organização já tem outro armazém de vendas.',
      })),
    );
    const { fixture } = await open({
      updateWarehouse,
      warehouses: () => of([{ ...WAREHOUSE, allowBackorder: true, allowNegative: true }]),
    });
    expect(text()).toContain('Encomendas em falta');
    expect(text()).toContain('Saldo negativo');
    button('Usar nas vendas').click();
    await settle(fixture);
    expect(text()).toContain('já tem outro armazém de vendas');
  });

  it('cria um armazém depois de validar e abre os seus locais', async () => {
    const createWarehouse = vi.fn(() => of(WAREHOUSE));
    const { fixture } = await open({ createWarehouse });
    button('Novo armazém').click();
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createWarehouse).not.toHaveBeenCalled();
    expect(text()).toContain('Indique a organização, o código e o nome');
    type('Organização', 'o1');
    type('Código', 'ARM-2');
    type('Nome', 'Loja');
    await settle(fixture);
    button('Criar').click();
    await settle(fixture);
    expect(createWarehouse).toHaveBeenCalledWith({
      organizationId: 'o1',
      code: 'ARM-2',
      name: 'Loja',
      allowNegative: false,
      allowBackorder: false,
    });
    expect(document.body.querySelector('[data-testid=locations-title]')?.textContent).toContain(
      'Central',
    );
  });

  it('acrescenta um local e valida o código', async () => {
    const createLocation = vi.fn(() => of(WAREHOUSE.locations![0]));
    const { fixture } = await open({ createLocation });
    button('Locais').click();
    await settle(fixture);
    button('Adicionar local').click();
    await settle(fixture);
    expect(createLocation).not.toHaveBeenCalled();
    expect(text()).toContain('Indique o código e o nome do local');
    const form = document.body.querySelector('[data-testid=location-form]')!;
    const inputs = form.querySelectorAll('input');
    inputs[0]!.value = 'A1';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[1]!.value = 'Corredor A1';
    inputs[1]!.dispatchEvent(new Event('input'));
    await settle(fixture);
    button('Adicionar local').click();
    await settle(fixture);
    expect(createLocation).toHaveBeenCalledWith('w1', { code: 'A1', name: 'Corredor A1' });
  });

  it('sem warehouse.manage só se vê', async () => {
    await open({}, ['inventory.read']);
    expect(buttons('Novo armazém')).toHaveLength(0);
    expect(buttons('Usar nas vendas')).toHaveLength(0);
    expect(buttons('Locais')).toHaveLength(1);
  });
});

describe('LotsTab', () => {
  it('procura a variante, lista lotes e valida as datas', async () => {
    const createLot = vi.fn(() => of({ id: 'lot2' }));
    configure({
      createLot,
      variantBySku: () =>
        of({
          id: 'v2',
          sku: 'IOG-1',
          productName: 'Iogurte',
          trackStock: true,
          trackingMode: 'LOT',
        }),
      lots: () =>
        of([
          {
            id: 'lot1',
            variantId: 'v2',
            code: 'L1',
            manufacturedOn: null,
            expiresOn: '2099-01-01',
          },
        ]),
    });
    const fixture = TestBed.createComponent(LotsTab);
    await settle(fixture);
    type('SKU', 'IOG-1');
    await settle(fixture);
    button('Procurar').click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=lots]')?.textContent).toContain('2099-01-01');
    const form = document.body.querySelector('[data-testid=lot-form]')!;
    const [code, made, expires] = [...form.querySelectorAll('input')];
    const set = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set(code!, 'L2');
    set(made!, '2026-05-01');
    set(expires!, '2026-01-01');
    await settle(fixture);
    button('Criar lote').click();
    await settle(fixture);
    expect(createLot).not.toHaveBeenCalled();
    expect(text()).toContain('validade não pode ser anterior');
    set(expires!, '2027-01-01');
    await settle(fixture);
    button('Criar lote').click();
    await settle(fixture);
    expect(createLot).toHaveBeenCalledWith({
      variantId: 'v2',
      code: 'L2',
      manufacturedOn: '2026-05-01',
      expiresOn: '2027-01-01',
    });
  });

  it('uma variante sem rastreio por lote não tem lotes', async () => {
    configure();
    const fixture = TestBed.createComponent(LotsTab);
    await settle(fixture);
    type('SKU', 'CAM-001');
    await settle(fixture);
    button('Procurar').click();
    await settle(fixture);
    expect(text()).toContain('não tem lotes');
    expect(document.body.querySelector('[data-testid=lot-form]')).toBeNull();
  });
});

describe('InventoryPage', () => {
  it('mostra os separadores com inventory.read e salta para os movimentos de uma variante', async () => {
    const mocked = configure();
    const fixture = TestBed.createComponent(InventoryPage);
    await settle(fixture);
    for (const id of ['stock', 'movements', 'reservations', 'warehouses', 'lots']) {
      expect(document.body.querySelector(`[data-testid=tab-${id}]`)).not.toBeNull();
    }
    // O primeiro «Movimentos» é o separador; o último, o botão da linha de saldo.
    [...buttons('Movimentos')].at(-1)!.click();
    await settle(fixture);
    expect(mocked.movements).toHaveBeenCalledWith({ limit: 25, offset: 0, variantId: 'v1' });
    expect(document.body.querySelector('[data-testid=movement-filter]')).not.toBeNull();
  });

  it('sem inventory.read não mostra separadores', async () => {
    configure({}, []);
    const fixture = TestBed.createComponent(InventoryPage);
    await settle(fixture);
    expect(document.body.querySelector('[role=tab]')).toBeNull();
  });
});
