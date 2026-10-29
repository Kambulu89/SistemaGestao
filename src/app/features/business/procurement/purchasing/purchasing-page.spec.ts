import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { OrdersApi } from '../../sales/orders/orders.api';
import {
  PurchasingApi,
  type PurchaseDto,
  type ReceiptDto,
  type RequisitionDto,
  type SupplierDto,
} from './purchasing.api';
import { PurchasingPage } from './purchasing-page';

const ALL = [
  'supplier.read',
  'supplier.manage',
  'requisition.read',
  'requisition.manage',
  'requisition.approve',
  'purchase.read',
  'purchase.manage',
  'purchase.confirm',
  'receipt.read',
  'receipt.manage',
  'receipt.post',
];

const supplier = (over: Partial<SupplierDto> = {}): SupplierDto => ({
  id: 's1',
  partyId: 'p1',
  organizationId: 'org1',
  code: 'FOR-001',
  paymentTermDays: 30,
  currency: 'AOA',
  status: 'ACTIVE',
  statusReason: null,
  partyName: 'Fornecedora, SA',
  taxId: '5000099999',
  version: 1,
  ...over,
});

const requisition = (over: Partial<RequisitionDto> = {}): RequisitionDto => ({
  id: 'r1',
  organizationId: 'org1',
  requestedByMembershipId: 'm1',
  number: null,
  status: 'DRAFT',
  neededOn: null,
  notes: null,
  decisionReason: null,
  purchaseOrderId: null,
  version: 1,
  lines: [
    {
      id: 'rl1',
      position: 1,
      variantId: 'v1',
      description: 'Camisola — CAM-001',
      quantity: '5.000000',
    },
  ],
  ...over,
});

const purchase = (over: Partial<PurchaseDto> = {}): PurchaseDto => ({
  id: 'po1',
  organizationId: 'org1',
  supplierId: 's1',
  requisitionId: null,
  number: null,
  orderDate: '2026-10-29',
  currency: 'AOA',
  status: 'DRAFT',
  notes: null,
  totals: { net: '100.0000', tax: '14.0000', total: '114.0000' },
  cancelReason: null,
  version: 1,
  lines: [
    {
      id: 'pl1',
      position: 1,
      variantId: 'v1',
      description: 'Camisola — CAM-001',
      quantity: '10.000000',
      unitCost: '10.0000',
      taxRate: '14',
      netAmount: '100.0000',
      taxAmount: '14.0000',
      total: '114.0000',
      receivedQty: '4.000000',
    },
  ],
  ...over,
});

const receipt = (over: Partial<ReceiptDto> = {}): ReceiptDto => ({
  id: 'g1',
  purchaseOrderId: 'po1',
  warehouseId: 'w1',
  number: null,
  status: 'DRAFT',
  supplierDocument: null,
  receivedAt: null,
  reverseReason: null,
  version: 1,
  lines: [
    { id: 'gl1', purchaseLineId: 'pl1', quantity: '6.000000', lotCode: null, expiresOn: null },
  ],
  ...over,
});

const page = <T>(items: T[]) => ({ items, total: items.length });
const confirmed = purchase({ number: 'OC A/2026/1', status: 'PARTIAL' });

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    suppliers: vi.fn(() => of(page([supplier()]))),
    parties: vi.fn(() => of([{ id: 'p1', displayName: 'Fornecedora, SA' }])),
    organizations: vi.fn(() => of([{ id: 'org1', code: 'EMP', legalName: 'Empresa, Lda.' }])),
    warehouses: vi.fn(() =>
      of([{ id: 'w1', organizationId: 'org1', code: 'ARM-1', name: 'Central' }]),
    ),
    requisitions: vi.fn(() => of(page([requisition()]))),
    requisition: vi.fn(() => of(requisition())),
    purchases: vi.fn(() => of(page([purchase(), confirmed]))),
    purchase: vi.fn(() => of(purchase())),
    receipts: vi.fn(() => of(page([receipt()]))),
    receipt: vi.fn(() => of(receipt())),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: PurchasingApi, useValue: full },
      { provide: OrdersApi, useValue: { variantIdBySku: vi.fn(() => of('v1')) } },
    ],
  });
  return full;
}

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const mocked = configure(api, granted);
  const fixture = TestBed.createComponent(PurchasingPage);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();
  };
  await settle();
  const buttons = (label: string) =>
    [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
  const click = async (label: string, at = 0) => {
    buttons(label)[at]!.click();
    await settle();
  };
  const tab = async (id: string) => {
    document.body.querySelector<HTMLButtonElement>(`[data-testid=tab-${id}]`)!.click();
    await settle();
  };
  const text = () => document.body.textContent ?? '';
  const field = (label: string) => {
    const lab = [...document.body.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    return document.body.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
  };
  const type = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  return { mocked, settle, buttons, click, tab, text, field, type };
}

describe('PurchasingPage', () => {
  it('mostra só os separadores permitidos', async () => {
    await open({}, ['purchase.read']);
    const tabs = [...document.body.querySelectorAll('[role=tab]')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['Encomendas']);
  });
});

describe('Fornecedores', () => {
  it('cria sobre uma Party validando o código e o prazo', async () => {
    const createSupplier = vi.fn(() => of(supplier()));
    const { click, field, type, text } = await open({ createSupplier });
    expect(text()).toContain('Fornecedora, SA');
    await click('Novo fornecedor');
    await click('Criar fornecedor');
    expect(text()).toContain('Escolha a pessoa ou organização');
    await type(field('Procurar pessoa ou organização'), 'Forn');
    await type(field('Pessoa ou organização'), 'p1');
    await click('Criar fornecedor');
    expect(text()).toContain('Indique o código');
    await type(field('Código'), 'FOR-001');
    await type(field('Prazo de pagamento (dias)'), '-1');
    await click('Criar fornecedor');
    expect(text()).toContain('Prazo: inteiro entre 0 e 3650 dias');
    await type(field('Prazo de pagamento (dias)'), '30');
    await click('Criar fornecedor');
    expect(createSupplier).toHaveBeenCalledWith({
      partyId: 'p1',
      organizationId: 'org1',
      code: 'FOR-001',
      paymentTermDays: 30,
    });
  });

  it('bloqueia com motivo e reactiva', async () => {
    const updateSupplier = vi
      .fn()
      .mockReturnValueOnce(
        of(supplier({ status: 'BLOCKED', statusReason: 'Auditoria', version: 2 })),
      )
      .mockReturnValueOnce(of(supplier({ version: 3 })));
    const { click, field, type, text } = await open({ updateSupplier });
    await click('Abrir');
    await click('Bloquear');
    expect(text()).toContain('Indique o motivo do bloqueio');
    await type(field('Motivo do bloqueio'), 'Auditoria');
    await click('Bloquear');
    expect(updateSupplier).toHaveBeenCalledWith('s1', 1, {
      status: 'BLOCKED',
      statusReason: 'Auditoria',
    });
    expect(document.body.querySelector('[data-testid=supplier-reason]')?.textContent).toContain(
      'Auditoria',
    );
    await click('Reactivar');
    expect(updateSupplier).toHaveBeenLastCalledWith('s1', 2, {
      status: 'ACTIVE',
      statusReason: null,
    });
  });
});

describe('Requisições', () => {
  it('cria o rascunho com linhas por SKU e submete', async () => {
    const createRequisition = vi.fn(() => of(requisition()));
    const submitRequisition = vi.fn(() =>
      of({
        requisition: requisition({ number: 'REQ A/2026/1', status: 'SUBMITTED' }),
        idempotent: false,
      }),
    );
    const { tab, click, field, type, text } = await open({ createRequisition, submitRequisition });
    await tab('requisitions');
    await click('Nova requisição');
    await click('Criar rascunho');
    expect(text()).toContain('Acrescente pelo menos uma linha');
    await type(field('SKU'), 'CAM-001');
    await type(field('Quantidade'), '0');
    await click('Adicionar linha');
    expect(text()).toContain('Quantidade positiva com até 6 casas');
    await type(field('Quantidade'), '5');
    await click('Adicionar linha');
    expect(document.body.querySelector('[data-testid=draft-lines]')?.textContent).toContain(
      'CAM-001 × 5',
    );
    await click('Criar rascunho');
    expect(createRequisition).toHaveBeenCalledWith({
      organizationId: 'org1',
      neededOn: null,
      lines: [{ variantId: 'v1', quantity: '5' }],
    });
    await click('Submeter');
    expect(text()).toContain('Requisição REQ A/2026/1 submetida.');
  });

  it('aprova (a segregação é do servidor) e rejeita com motivo', async () => {
    const submitted = requisition({ number: 'REQ A/2026/1', status: 'SUBMITTED' });
    const approveRequisition = vi
      .fn()
      .mockReturnValueOnce(throwError(() => ({ code: 'SEGREGATION_OF_DUTIES', message: 'x' })))
      .mockReturnValueOnce(
        of({ requisition: { ...submitted, status: 'APPROVED' }, idempotent: false }),
      );
    const rejectRequisition = vi.fn(() =>
      of({ requisition: { ...submitted, status: 'REJECTED' }, idempotent: false }),
    );
    const { tab, click, field, type, text, buttons } = await open({
      approveRequisition,
      rejectRequisition,
      requisitions: vi.fn(() => of(page([submitted]))),
      requisition: vi.fn(() => of(submitted)),
    });
    await tab('requisitions');
    await click('Abrir');
    await click('Aprovar');
    expect(text()).toContain('Quem pediu a requisição não a pode aprovar nem rejeitar');
    await click('Rejeitar');
    expect(text()).toContain('Indique o motivo da rejeição');
    await type(field('Motivo da decisão'), 'Sem orçamento');
    await click('Rejeitar');
    expect(rejectRequisition).toHaveBeenCalledWith('r1', 'Sem orçamento');
    expect(text()).toContain('Requisição rejeitada.');
    expect(buttons('Aprovar')).toHaveLength(0);
  });

  it('converte uma aprovada exigindo o fornecedor e o custo de cada linha', async () => {
    const approved = requisition({ number: 'REQ A/2026/1', status: 'APPROVED' });
    const convertRequisition = vi.fn(() =>
      of({ order: purchase({ requisitionId: 'r1' }), idempotent: false }),
    );
    const { tab, click, field, type, text } = await open({
      convertRequisition,
      requisitions: vi.fn(() => of(page([approved]))),
      requisition: vi.fn(() => of(approved)),
    });
    await tab('requisitions');
    await click('Abrir');
    await click('Converter em encomenda');
    expect(text()).toContain('Escolha o fornecedor');
    await type(field('Fornecedor'), 's1');
    await click('Converter em encomenda');
    expect(text()).toContain('indique o custo');
    const cost = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Custo unitário de Camisola — CAM-001"]',
    )!;
    await type(cost, '5');
    await click('Converter em encomenda');
    expect(convertRequisition).toHaveBeenCalledWith('r1', {
      supplierId: 's1',
      lines: [{ variantId: 'v1', unitCost: '5', taxRate: '0' }],
    });
    expect(text()).toContain('Encomenda criada em rascunho');
  });
});

describe('Encomendas', () => {
  it('cria o rascunho, acrescenta uma linha validada e confirma', async () => {
    const createPurchase = vi.fn(() => of(purchase({ lines: [] })));
    const addPurchaseLine = vi.fn(() => of(purchase()));
    const confirmPurchase = vi.fn(() =>
      of({ order: purchase({ number: 'OC A/2026/1', status: 'ORDERED' }), idempotent: false }),
    );
    const { tab, click, field, type, text, buttons } = await open({
      createPurchase,
      addPurchaseLine,
      confirmPurchase,
    });
    await tab('orders');
    await click('Nova encomenda');
    await click('Criar rascunho');
    expect(text()).toContain('Escolha o fornecedor');
    await type(field('Fornecedor'), 's1');
    await click('Criar rascunho');
    expect(createPurchase).toHaveBeenCalledWith({ supplierId: 's1' });
    await click('Adicionar linha');
    expect(text()).toContain('Indique o SKU');
    await type(field('SKU'), 'CAM-001');
    await type(field('Quantidade'), '10');
    await type(field('Custo unitário'), '-1');
    await click('Adicionar linha');
    expect(text()).toContain('Custo com até 4 casas');
    await type(field('Custo unitário'), '10');
    await type(field('Taxa (%)'), '14');
    await click('Adicionar linha');
    expect(addPurchaseLine).toHaveBeenCalledWith('po1', {
      variantId: 'v1',
      quantity: '10',
      unitCost: '10',
      taxRate: '14',
    });
    expect(document.body.querySelector('[data-testid=purchase-totals]')?.textContent).toContain(
      '114,0000',
    );
    await click('Confirmar');
    expect(text()).toContain('Encomenda OC A/2026/1 confirmada.');
    expect(buttons('Confirmar')).toHaveLength(0);
  });

  it('cancela com motivo e mostra o que o servidor recusa', async () => {
    const ordered = purchase({ number: 'OC A/2026/1', status: 'ORDERED' });
    const cancelPurchase = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => ({ code: 'PURCHASE_ORDER_HAS_RECEIPTS', message: 'x' })),
      )
      .mockReturnValueOnce(of({ order: { ...ordered, status: 'CANCELLED' }, idempotent: false }));
    const { tab, click, field, type, text } = await open({
      cancelPurchase,
      purchases: vi.fn(() => of(page([ordered]))),
      purchase: vi.fn(() => of(ordered)),
    });
    await tab('orders');
    await click('Abrir');
    await click('Cancelar encomenda');
    expect(text()).toContain('Indique o motivo do cancelamento');
    await type(field('Motivo do cancelamento'), 'Desistência');
    await click('Cancelar encomenda');
    expect(text()).toContain('reverta as recepções');
    await click('Cancelar encomenda');
    expect(cancelPurchase).toHaveBeenLastCalledWith('po1', 'Desistência');
    expect(text()).toContain('Encomenda cancelada.');
  });

  it('só mostra confirmar a quem tem a permissão', async () => {
    const { tab, click, buttons } = await open({}, ['purchase.read', 'purchase.manage']);
    await tab('orders');
    await click('Abrir');
    expect(buttons('Confirmar')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(1);
  });
});

describe('Recepções', () => {
  it('propõe o saldo por receber e cria o rascunho com armazém, lote e validade', async () => {
    const createReceipt = vi.fn(() => of(receipt()));
    const { tab, click, field, type, text } = await open({
      createReceipt,
      purchases: vi.fn(() => of(page([confirmed]))),
      purchase: vi.fn(() => of(confirmed)),
    });
    await tab('receipts');
    await click('Nova recepção');
    await type(field('Encomenda'), 'po1');
    await type(field('Armazém'), 'w1');
    const rows = () =>
      document.body.querySelectorAll<HTMLInputElement>('[data-testid=receive-lines] input');
    expect(rows()[0]!.value).toBe('6');
    await type(rows()[0]!, '7');
    await click('Criar rascunho');
    expect(text()).toContain('quantidade positiva até 6');
    await type(rows()[0]!, '6');
    await type(rows()[2]!, '2099-02-30');
    await click('Criar rascunho');
    expect(text()).toContain('validade inválida');
    await type(rows()[1]!, 'L-1');
    await type(rows()[2]!, '2099-01-31');
    await click('Criar rascunho');
    expect(createReceipt).toHaveBeenCalledWith({
      purchaseOrderId: 'po1',
      warehouseId: 'w1',
      supplierDocument: null,
      lines: [{ purchaseLineId: 'pl1', quantity: '6', lotCode: 'L-1', expiresOn: '2099-01-31' }],
    });
    expect(text()).toContain('Rascunho criado');
  });

  it('lança e mostra o motivo se o servidor recusa; reverte com motivo', async () => {
    const postReceipt = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => ({
          code: 'GOODS_RECEIPT_NOT_POSTABLE',
          message: 'x',
          fieldErrors: [{ path: 'lines[0]', code: 'LOT_REQUIRED', message: 'm' }],
        })),
      )
      .mockReturnValueOnce(
        of({ receipt: receipt({ number: 'REC A/2026/1', status: 'POSTED' }), idempotent: false }),
      );
    const reverseReceipt = vi.fn(() =>
      of({
        receipt: receipt({ number: 'REC A/2026/1', status: 'REVERSED', reverseReason: 'Engano' }),
        idempotent: false,
      }),
    );
    const { tab, click, field, type, text, buttons } = await open({
      postReceipt,
      reverseReceipt,
      purchase: vi.fn(() => of(confirmed)),
    });
    await tab('receipts');
    await click('Abrir');
    expect(text()).toContain('Camisola — CAM-001');
    await click('Lançar');
    expect(text()).toContain('Este produto exige o código do lote');
    await click('Lançar');
    expect(text()).toContain('Recepção REC A/2026/1 lançada: o stock deu entrada.');
    expect(buttons('Lançar')).toHaveLength(0);
    await click('Reverter');
    expect(text()).toContain('Indique o motivo da reversão');
    await type(field('Motivo da reversão'), 'Engano');
    await click('Reverter');
    expect(reverseReceipt).toHaveBeenCalledWith('g1', 'Engano');
    expect(text()).toContain('Recepção revertida');
  });

  it('apaga um rascunho e respeita as permissões', async () => {
    const deleteReceipt = vi.fn(() => of(undefined));
    const { tab, click, text } = await open({
      deleteReceipt,
      purchase: vi.fn(() => of(confirmed)),
    });
    await tab('receipts');
    await click('Abrir');
    await click('Apagar rascunho');
    expect(deleteReceipt).toHaveBeenCalledWith('g1');
    expect(text()).toContain('Rascunho apagado.');
  });

  it('sem manage não cria; sem post não lança', async () => {
    const { buttons, click } = await open({ purchase: vi.fn(() => of(confirmed)) }, [
      'receipt.read',
    ]);
    expect(buttons('Nova recepção')).toHaveLength(0);
    await click('Abrir');
    expect(buttons('Lançar')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(0);
  });
});
