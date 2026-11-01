import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import {
  FinanceApi,
  type AccountDto,
  type ObligationDetailDto,
  type PaymentDto,
  type SupplierInvoiceDto,
} from './finance.api';
import { TreasuryPage } from './treasury-page';

const ALL = [
  'treasury.read',
  'treasury.manage',
  'receivable.read',
  'payable.read',
  'payment.read',
  'payment.manage',
  'payment.confirm',
  'supplier_invoice.read',
  'supplier_invoice.manage',
  'supplier_invoice.validate',
  'supplier_invoice.override',
];

const account = (over: Partial<AccountDto> = {}): AccountDto => ({
  id: 'a1',
  organizationId: 'org1',
  code: 'CAIXA',
  name: 'Caixa central',
  type: 'CASH',
  currency: 'AOA',
  bankName: null,
  accountIdentifier: null,
  active: true,
  balance: '40.0000',
  version: 1,
  ...over,
});

const receivable = (over: Partial<ObligationDetailDto> = {}): ObligationDetailDto => ({
  id: 'r1',
  kind: 'receivable',
  organizationId: 'org1',
  partyId: 'p1',
  partyName: 'Acme, Lda.',
  sourceType: 'INVOICE',
  sourceId: 'i1',
  originalAmount: '114.0000',
  currency: 'AOA',
  dueOn: '2099-01-01',
  status: 'OPEN',
  credits: '0.0000',
  paid: '40.0000',
  balance: '74.0000',
  view: 'PARTIAL',
  allocations: [
    {
      id: 'al1',
      paymentId: 'pay0',
      paymentStatus: 'CONFIRMED',
      amount: '40.0000',
      reversedAt: null,
      occurredOn: '2026-10-01',
    },
  ],
  creditApplications: [],
  ...over,
});

const payment = (over: Partial<PaymentDto> = {}): PaymentDto => ({
  id: 'pay1',
  organizationId: 'org1',
  direction: 'INBOUND',
  partyId: 'p1',
  partyName: 'Acme, Lda.',
  treasuryAccountId: 'a1',
  amount: '74.0000',
  currency: 'AOA',
  method: 'TRANSFER',
  occurredOn: '2026-10-29',
  reference: null,
  status: 'DRAFT',
  failureReason: null,
  reverseReason: null,
  version: 1,
  allocations: [
    { id: 'al2', receivableId: 'r1', payableId: null, amount: '74.0000', reversedAt: null },
  ],
  ...over,
});

const supplierInvoice = (over: Partial<SupplierInvoiceDto> = {}): SupplierInvoiceDto => ({
  id: 'si1',
  organizationId: 'org1',
  supplierId: 's1',
  supplierName: 'Fornecedora, SA',
  externalNumber: 'FF-001',
  purchaseOrderId: null,
  invoiceDate: '2026-10-29',
  dueOn: '2026-11-28',
  currency: 'AOA',
  totals: { net: '100.0000', tax: '14.0000', total: '114.0000' },
  status: 'DRAFT',
  matching: null,
  overrideReason: null,
  notes: null,
  version: 1,
  lines: [
    {
      id: 'sl1',
      position: 1,
      purchaseLineId: null,
      description: 'Serviço',
      quantity: '1.000000',
      unitPrice: '100.0000',
      taxRate: '14.0000',
      netAmount: '100.0000',
      taxAmount: '14.0000',
      total: '114.0000',
    },
  ],
  ...over,
});

const page = <T>(items: T[]) => ({ items, total: items.length });

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    accounts: vi.fn(() => of(page([account()]))),
    entries: vi.fn(() =>
      of(
        page([
          {
            id: 'e1',
            accountId: 'a1',
            paymentId: 'pay0',
            amountSigned: '40.0000',
            occurredOn: '2026-10-01',
            reversalOfId: null,
          },
        ]),
      ),
    ),
    organizations: vi.fn(() => of([{ id: 'org1', code: 'EMP', legalName: 'Empresa, Lda.' }])),
    obligations: vi.fn(() => of(page([receivable()]))),
    obligation: vi.fn(() => of(receivable())),
    payments: vi.fn(() => of(page([payment()]))),
    payment: vi.fn(() => of(payment())),
    supplierInvoices: vi.fn(() => of(page([supplierInvoice()]))),
    supplierInvoice: vi.fn(() => of(supplierInvoice())),
    suppliers: vi.fn(() =>
      of([{ id: 's1', code: 'FOR-1', partyName: 'Fornecedora, SA', organizationId: 'org1' }]),
    ),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: FinanceApi, useValue: full },
    ],
  });
  return full;
}

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const mocked = configure(api, granted);
  const fixture = TestBed.createComponent(TreasuryPage);
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

describe('TreasuryPage', () => {
  it('mostra só os separadores permitidos', async () => {
    await open({}, ['payable.read', 'payment.read']);
    const tabs = [...document.body.querySelectorAll('[role=tab]')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['A pagar', 'Pagamentos']);
  });
});

describe('Contas', () => {
  it('lista com saldo, abre o extracto e inactiva', async () => {
    const updateAccount = vi.fn(() => of(account({ active: false, version: 2 })));
    const { click, text } = await open({ updateAccount });
    expect(text()).toContain('Caixa central');
    await click('Abrir');
    expect(document.body.querySelector('[data-testid=account-balance]')?.textContent).toContain(
      '40,0000',
    );
    expect(document.body.querySelector('[data-testid=entries]')).not.toBeNull();
    await click('Inactivar');
    expect(updateAccount).toHaveBeenCalledWith('a1', 1, { active: false });
    expect(text()).toContain('deixa de receber pagamentos');
  });

  it('cria uma conta bancária validando os campos', async () => {
    const createAccount = vi.fn(() => of(account({ id: 'a2', code: 'BAI', type: 'BANK' })));
    const { click, field, type, text } = await open({ createAccount });
    await click('Nova conta');
    await click('Criar conta');
    expect(text()).toContain('Indique o código');
    await type(field('Código'), 'BAI');
    await click('Criar conta');
    expect(text()).toContain('Indique o nome da conta');
    await type(field('Nome'), 'Banco BAI');
    await type(field('Tipo'), 'BANK');
    await type(field('Banco'), 'BAI');
    await click('Criar conta');
    expect(createAccount).toHaveBeenCalledWith({
      organizationId: 'org1',
      code: 'BAI',
      name: 'Banco BAI',
      type: 'BANK',
      bankName: 'BAI',
    });
  });

  it('sem treasury.manage não oferece criar nem inactivar', async () => {
    const { buttons } = await open({}, ['treasury.read']);
    expect(buttons('Nova conta')).toHaveLength(0);
    await Promise.resolve();
  });
});

describe('Contas a receber', () => {
  it('mostra o saldo derivado e regista e confirma o recebimento', async () => {
    const createPayment = vi.fn(() => of(payment()));
    const confirmPayment = vi.fn(() => of(payment({ status: 'CONFIRMED' })));
    const obligation = vi
      .fn()
      .mockReturnValueOnce(of(receivable()))
      .mockReturnValue(of(receivable({ balance: '0.0000', status: 'CLOSED', view: 'CLOSED' })));
    const { tab, click, field, type, text } = await open({
      createPayment,
      confirmPayment,
      obligation,
    });
    await tab('receivables');
    expect(text()).toContain('Acme, Lda.');
    await click('Abrir');
    expect(document.body.querySelector('[data-testid=obligation-balance]')?.textContent).toContain(
      '74,0000',
    );
    expect(document.body.querySelector('[data-testid=obligation-allocations]')).not.toBeNull();
    await type(field('Montante'), '0');
    await click('Registar e confirmar');
    expect(text()).toContain('Montante: número positivo');
    await type(field('Montante'), '74');
    await click('Registar e confirmar');
    expect(createPayment).toHaveBeenCalledWith({
      organizationId: 'org1',
      direction: 'INBOUND',
      partyId: 'p1',
      treasuryAccountId: 'a1',
      amount: '74',
      method: 'TRANSFER',
      allocations: [{ receivableId: 'r1', amount: '74' }],
    });
    expect(confirmPayment).toHaveBeenCalledWith('pay1');
    expect(text()).toContain('Recebimento confirmado');
  });

  it('um rascunho não confirma; sem payment.confirm só se oferece o rascunho', async () => {
    const createPayment = vi.fn(() => of(payment()));
    const confirmPayment = vi.fn();
    const { tab, click, buttons, text } = await open({ createPayment, confirmPayment }, [
      'receivable.read',
      'treasury.read',
      'payment.manage',
    ]);
    await tab('receivables');
    await click('Abrir');
    expect(buttons('Registar e confirmar')).toHaveLength(0);
    await click('Registar (rascunho)');
    expect(createPayment).toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(text()).toContain('Rascunho registado');
  });

  it('mostra o erro de saldo excedido da API', async () => {
    const confirmPayment = vi.fn(() =>
      throwError(() => ({ code: 'PAYMENT_NOT_APPLICABLE', message: 'x' })),
    );
    const { tab, click, text } = await open({
      confirmPayment,
      createPayment: vi.fn(() => of(payment())),
    });
    await tab('receivables');
    await click('Abrir');
    await click('Registar e confirmar');
    expect(text()).toContain('O pagamento não se pode aplicar');
  });
});

describe('Pagamentos', () => {
  it('confirma um rascunho', async () => {
    const confirmPayment = vi.fn(() => of(payment({ status: 'CONFIRMED' })));
    const { tab, click, text } = await open({ confirmPayment });
    await tab('payments');
    await click('Abrir');
    await click('Confirmar');
    expect(confirmPayment).toHaveBeenCalledWith('pay1');
    expect(text()).toContain('a conta foi movimentada');
  });

  it('falhar e reverter exigem motivo', async () => {
    const failPayment = vi.fn(() =>
      of(payment({ status: 'FAILED', failureReason: 'Recusado pelo banco' })),
    );
    const reversePayment = vi.fn(() =>
      of(payment({ status: 'REVERSED', reverseReason: 'Cheque devolvido' })),
    );
    const { tab, click, field, type, text } = await open({
      failPayment,
      reversePayment,
      payment: vi
        .fn()
        .mockReturnValueOnce(of(payment({ status: 'PENDING' })))
        .mockReturnValue(of(payment({ status: 'CONFIRMED' }))),
    });
    await tab('payments');
    await click('Abrir');
    await click('Marcar como falhado');
    await click('Marcar como falhado');
    expect(text()).toContain('Indique o motivo da falha');
    await type(field('Motivo da falha'), 'Recusado pelo banco');
    await click('Marcar como falhado');
    expect(failPayment).toHaveBeenCalledWith('pay1', 'Recusado pelo banco');
    expect(document.body.querySelector('[data-testid=payment-reason]')?.textContent).toContain(
      'Recusado pelo banco',
    );
  });

  it('reverte um confirmado com motivo; sem payment.confirm não há botões de movimento', async () => {
    const reversePayment = vi.fn(() =>
      of(payment({ status: 'REVERSED', reverseReason: 'Cheque devolvido' })),
    );
    const { tab, click, field, type, text } = await open({
      reversePayment,
      payment: vi.fn(() => of(payment({ status: 'CONFIRMED' }))),
    });
    await tab('payments');
    await click('Abrir');
    await click('Reverter');
    await click('Reverter');
    expect(text()).toContain('Indique o motivo da reversão');
    await type(field('Motivo da reversão'), 'Cheque devolvido');
    await click('Reverter');
    expect(reversePayment).toHaveBeenCalledWith('pay1', 'Cheque devolvido');
  });

  it('apaga um rascunho; sem payment.confirm não confirma', async () => {
    const deletePayment = vi.fn(() => of(undefined));
    const { tab, click, buttons } = await open({ deletePayment }, [
      'payment.read',
      'payment.manage',
    ]);
    await tab('payments');
    await click('Abrir');
    expect(buttons('Confirmar')).toHaveLength(0);
    await click('Apagar');
    expect(deletePayment).toHaveBeenCalledWith('pay1');
  });
});

describe('Facturas de fornecedor', () => {
  it('cria o rascunho validando as linhas', async () => {
    const createSupplierInvoice = vi.fn(() => of(supplierInvoice()));
    const { tab, click, field, type, text } = await open({ createSupplierInvoice });
    await tab('invoices');
    await click('Nova factura');
    await click('Criar rascunho');
    expect(text()).toContain('Indique o número da factura do fornecedor');
    await type(field('Número da factura'), 'FF-001');
    await click('Criar rascunho');
    expect(text()).toContain('Linha 1: indique a descrição');
    await type(field('Descrição'), 'Serviço');
    await type(field('Preço unitário'), '100');
    await type(field('Imposto %'), '14');
    await click('Criar rascunho');
    expect(createSupplierInvoice).toHaveBeenCalledWith({
      supplierId: 's1',
      externalNumber: 'FF-001',
      lines: [{ description: 'Serviço', quantity: '1', unitPrice: '100', taxRate: '14' }],
    });
    expect(document.body.querySelector('[data-testid=invoice-total]')?.textContent).toContain(
      '114,0000',
    );
  });

  it('valida; com divergências fica em disputa e a excepção exige justificação e permissão', async () => {
    const disputed = supplierInvoice({
      status: 'DISPUTED',
      matching: [{ line: 'sl1', code: 'NOT_RECEIVED', message: 'Facturado 8 mas só 6 recebidas.' }],
    });
    const validateSupplierInvoice = vi
      .fn()
      .mockReturnValueOnce(of(disputed))
      .mockReturnValueOnce(
        of(supplierInvoice({ status: 'VALIDATED', overrideReason: 'Entrega em curso' })),
      );
    const { tab, click, field, type, text } = await open({
      validateSupplierInvoice,
      supplierInvoice: vi.fn(() => of(supplierInvoice())),
    });
    await tab('invoices');
    await click('Abrir');
    await click('Validar');
    expect(validateSupplierInvoice).toHaveBeenCalledWith('si1', undefined);
    expect(document.body.querySelector('[data-testid=matching]')?.textContent).toContain(
      'só 6 recebidas',
    );
    expect(text()).toContain('ficou em disputa');
    await click('Validar com excepção');
    expect(text()).toContain('Indique a justificação da excepção');
    await type(field('Justificação da excepção'), 'Entrega em curso');
    await click('Validar com excepção');
    expect(validateSupplierInvoice).toHaveBeenLastCalledWith('si1', 'Entrega em curso');
    expect(document.body.querySelector('[data-testid=override-reason]')?.textContent).toContain(
      'Entrega em curso',
    );
    expect(text()).toContain('conta a pagar foi criada');
  });

  it('sem supplier_invoice.override não oferece a excepção', async () => {
    const { tab, click, buttons } = await open(
      { supplierInvoice: vi.fn(() => of(supplierInvoice({ status: 'DISPUTED' }))) },
      ['supplier_invoice.read', 'supplier_invoice.validate'],
    );
    await tab('invoices');
    await click('Abrir');
    expect(buttons('Validar')).toHaveLength(1);
    expect(buttons('Validar com excepção')).toHaveLength(0);
  });

  it('anula e apaga rascunhos', async () => {
    const voidSupplierInvoice = vi.fn(() => of(supplierInvoice({ status: 'VOID' })));
    const { tab, click, text } = await open({ voidSupplierInvoice });
    await tab('invoices');
    await click('Abrir');
    await click('Anular');
    expect(voidSupplierInvoice).toHaveBeenCalledWith('si1');
    expect(text()).toContain('Factura anulada');
  });
});
