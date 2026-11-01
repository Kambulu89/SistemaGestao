import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { InventoryApi } from '../stock/inventory.api';
import { InventoryPage } from '../stock/inventory-page';
import { CountsTab } from './counts-tab';
import {
  LogisticsApi,
  type CountDto,
  type ReturnDto,
  type TransferDto,
  type SourceLineDto,
} from './logistics.api';
import { logisticsError } from './logistics-model';
import { ReturnsTab } from './returns-tab';
import { TransfersTab } from './transfers-tab';

const WAREHOUSES = [
  { id: 'w1', code: 'ARM-1', name: 'Central', active: true, technical: false, locations: [] },
  { id: 'w2', code: 'ARM-2', name: 'Norte', active: true, technical: false, locations: [] },
  { id: 'wt', code: 'TRANSITO', name: 'Trânsito', active: true, technical: true, locations: [] },
];
const VARIANT = { id: 'v1', sku: 'CAM-001', productName: 'Camisola', trackStock: true };

const TRANSFER: TransferDto = {
  id: 't1',
  organizationId: 'o1',
  number: 'TR-000001',
  sourceWarehouseId: 'w1',
  destinationWarehouseId: 'w2',
  status: 'DRAFT',
  notes: null,
  cancelReason: null,
  version: 1,
  lines: [
    {
      id: 'tl1',
      position: 1,
      variantId: 'v1',
      lotId: null,
      quantity: '5.000000',
      dispatchedQty: '5.000000',
      receivedQty: '2.000000',
      inTransit: '3.000000',
    },
  ],
};
const COUNT: CountDto = {
  id: 'c1',
  organizationId: 'o1',
  warehouseId: 'w1',
  number: 'CT-000001',
  status: 'OPEN',
  blind: true,
  notes: null,
  version: 1,
  lines: [
    {
      id: 'cl1',
      variantId: 'v1',
      locationId: 'l1',
      lotId: null,
      expectedQty: null,
      countedQty: null,
      varianceQty: null,
      reason: null,
    },
  ],
};
const RETURN: ReturnDto = {
  id: 'r1',
  organizationId: 'o1',
  number: null,
  direction: 'CUSTOMER',
  sourceDocumentId: 'sh1',
  warehouseId: 'w1',
  reason: 'Defeito',
  status: 'DRAFT',
  version: 1,
  lines: [],
};
const SOURCE_LINE: SourceLineDto = {
  sourceLineId: 'sl1',
  variantId: 'v1',
  quantity: '4.000000',
  returned: '1.000000',
  returnable: '3.000000',
  unitCost: '6.0000',
};

const page = <T>(items: T[]) => ({ items, total: items.length });

const ALL = [
  'inventory.read',
  'transfer.read',
  'transfer.manage',
  'transfer.dispatch',
  'transfer.receive',
  'count.read',
  'count.manage',
  'count.post',
  'return.read',
  'return.manage',
  'return.post',
];

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const logistics = {
    transfers: vi.fn(() => of(page([TRANSFER]))),
    transfer: vi.fn(() => of(TRANSFER)),
    counts: vi.fn(() => of(page([COUNT]))),
    count: vi.fn(() => of(COUNT)),
    returns: vi.fn(() => of(page([RETURN]))),
    return: vi.fn(() => of(RETURN)),
    sourceDocuments: vi.fn(() => of([{ id: 'sh1', number: 'EXP-000001' }])),
    returnSourceLines: vi.fn(() => of([SOURCE_LINE])),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: LogisticsApi, useValue: logistics },
      {
        provide: InventoryApi,
        useValue: {
          warehouses: () => of(WAREHOUSES),
          warehouse: () =>
            of({
              ...WAREHOUSES[0],
              locations: [{ id: 'l1', code: 'PRINCIPAL', name: 'Principal' }],
            }),
          variant: () => of(VARIANT),
          variantBySku: vi.fn(() => of(VARIANT)),
          balances: () => of(page([])),
          movements: () => of(page([])),
          reservations: () => of(page([])),
          lots: () => of([]),
        },
      },
    ],
  });
  return logistics;
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

describe('TransfersTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(TransfersTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('mostra a origem e o destino pelo nome do armazém', async () => {
    await open();
    expect(text()).toContain('TR-000001');
    expect(text()).toContain('Central → Norte');
  });

  it('expede um rascunho', async () => {
    const dispatchTransfer = vi.fn(() => of({ ...TRANSFER, status: 'DISPATCHED' }));
    const { fixture } = await open({ dispatchTransfer });
    button('Expedir').click();
    await settle(fixture);
    expect(dispatchTransfer).toHaveBeenCalledWith('t1');
    expect(text()).toContain('em trânsito');
  });

  it('apagar o rascunho que está aberto não parte a página', async () => {
    const deleteTransfer = vi.fn(() => of(undefined));
    const transfer = vi
      .fn()
      .mockReturnValueOnce(of(TRANSFER))
      .mockReturnValue(throwError(() => ({ code: 'NOT_FOUND' })));
    const { fixture } = await open({ deleteTransfer, transfer });
    button('Linhas').click();
    await settle(fixture);
    expect(text()).toContain('Linhas de TR-000001');
    button('Apagar').click();
    await settle(fixture);
    expect(deleteTransfer).toHaveBeenCalledWith('t1');
    expect(text()).not.toContain('Linhas de TR-000001');
    expect(text()).toContain('Rascunho apagado');
  });

  it('só mostra as acções permitidas', async () => {
    await open({}, ['transfer.read']);
    expect(buttons('Expedir')).toHaveLength(0);
    expect(buttons('Nova transferência')).toHaveLength(0);
  });

  it('cria a partir do SKU com quantidades em texto e não oferece armazéns técnicos', async () => {
    const createTransfer = vi.fn(() => of(TRANSFER));
    const { fixture, mocked } = await open({ createTransfer });
    button('Nova transferência').click();
    await settle(fixture);
    expect(field('Armazém de origem').textContent).not.toContain('TRANSITO');
    type('Armazém de origem', 'w1');
    type('Armazém de destino', 'w2');
    type('SKU', 'CAM-001');
    type('Quantidade', '2.5');
    await settle(fixture);
    button('Criar rascunho').click();
    await settle(fixture);
    expect(mocked.transfers).toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith({
      sourceWarehouseId: 'w1',
      destinationWarehouseId: 'w2',
      lines: [{ variantId: 'v1', quantity: '2.5' }],
    });
  });

  it('recusa linhas sem quantidade positiva sem chamar o servidor', async () => {
    const createTransfer = vi.fn();
    const { fixture } = await open({ createTransfer });
    button('Nova transferência').click();
    await settle(fixture);
    type('Armazém de origem', 'w1');
    type('Armazém de destino', 'w2');
    type('SKU', 'CAM-001');
    type('Quantidade', '0');
    await settle(fixture);
    button('Criar rascunho').click();
    await settle(fixture);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(text()).toContain('quantidade positiva');
  });

  it('recebe o que está em trânsito e mostra o erro do servidor', async () => {
    const receiveTransfer = vi
      .fn()
      .mockReturnValueOnce(throwError(() => ({ code: 'EXCEEDS_IN_TRANSIT' })))
      .mockReturnValueOnce(of({ ...TRANSFER, status: 'RECEIVED' }));
    const { fixture } = await open({
      receiveTransfer,
      transfers: () => of(page([{ ...TRANSFER, status: 'DISPATCHED' }])),
    });
    button('Receber').click();
    await settle(fixture);
    button('Confirmar recepção').click();
    await settle(fixture);
    expect(receiveTransfer).toHaveBeenCalledWith('t1', [{ lineId: 'tl1', quantity: '3' }]);
    expect(text()).toContain('excede o que está em trânsito');
    button('Confirmar recepção').click();
    await settle(fixture);
    expect(receiveTransfer).toHaveBeenCalledTimes(2);
  });
});

describe('CountsTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(CountsTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('na contagem cega não mostra o saldo esperado e guarda o que se contou', async () => {
    const countLines = vi.fn(() => of(COUNT));
    const { fixture } = await open({ countLines });
    button('Linhas').click();
    await settle(fixture);
    expect(text()).not.toContain('esperado');
    expect(text()).toContain('PRINCIPAL · Principal');
    type('Contado', '7');
    await settle(fixture);
    button('Guardar contagem').click();
    await settle(fixture);
    expect(countLines).toHaveBeenCalledWith('c1', [{ lineId: 'cl1', countedQty: '7' }]);
  });

  it('não envia quantidades inválidas', async () => {
    const countLines = vi.fn();
    const { fixture } = await open({ countLines });
    button('Linhas').click();
    await settle(fixture);
    type('Contado', '-1');
    await settle(fixture);
    button('Guardar contagem').click();
    await settle(fixture);
    expect(countLines).not.toHaveBeenCalled();
  });

  it('lançar ajustes exige count.post', async () => {
    const review = { counts: () => of(page([{ ...COUNT, status: 'REVIEW' }])) };
    await open(review, ['count.read', 'count.manage']);
    expect(buttons('Lançar ajustes')).toHaveLength(0);
    TestBed.resetTestingModule();
    await open(review);
    expect(buttons('Lançar ajustes')).toHaveLength(1);
  });
});

describe('ReturnsTab', () => {
  async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
    const mocked = configure(api, granted);
    const fixture = TestBed.createComponent(ReturnsTab);
    await settle(fixture);
    return { fixture, mocked };
  }

  it('cria a devolução a partir das linhas do documento de origem', async () => {
    const createReturn = vi.fn(() => of(RETURN));
    const { fixture } = await open({ createReturn });
    button('Nova devolução').click();
    await settle(fixture);
    type('Expedição de origem', 'sh1');
    await settle(fixture);
    expect(text()).toContain('devolvível 3');
    type('Armazém que recebe/entrega', 'w1');
    type('Motivo', 'Defeito');
    type('Quantidade', '2');
    const condition = document.body.querySelector<HTMLSelectElement>(
      '[data-testid=source-line] select',
    )!;
    condition.value = 'DAMAGED';
    condition.dispatchEvent(new Event('change'));
    await settle(fixture);
    button('Criar rascunho').click();
    await settle(fixture);
    expect(createReturn).toHaveBeenCalledWith({
      direction: 'CUSTOMER',
      sourceDocumentId: 'sh1',
      warehouseId: 'w1',
      reason: 'Defeito',
      lines: [{ sourceLineId: 'sl1', quantity: '2', condition: 'DAMAGED' }],
    });
  });

  it('aprova e lança conforme o estado', async () => {
    const approveReturn = vi.fn(() => of({ ...RETURN, status: 'APPROVED' }));
    const { fixture } = await open({ approveReturn });
    button('Aprovar').click();
    await settle(fixture);
    expect(approveReturn).toHaveBeenCalledWith('r1');
  });

  it('sem return.post não há aprovar nem lançar', async () => {
    await open({}, ['return.read', 'return.manage']);
    expect(buttons('Aprovar')).toHaveLength(0);
    expect(buttons('Lançar')).toHaveLength(0);
  });
});

describe('InventoryPage com logística', () => {
  it('cada separador de logística depende da sua permissão de leitura', async () => {
    configure({}, ['inventory.read', 'count.read']);
    const fixture = TestBed.createComponent(InventoryPage);
    await settle(fixture);
    const tabs = [...document.body.querySelectorAll('[role=tab]')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toContain('Contagens');
    expect(tabs).not.toContain('Transferências');
    expect(tabs).not.toContain('Devoluções');
  });
});

describe('logisticsError', () => {
  it('traduz códigos da logística', () => {
    expect(logisticsError({ code: 'LOCATION_FROZEN' }, 'x')).toContain('congelado');
    expect(logisticsError({}, 'falhou')).toBe('falhou');
  });
});
