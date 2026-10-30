import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { OrdersApi, type OrderDto } from '../orders/orders.api';
import {
  BillingApi,
  type BillableLine,
  type ContractDto,
  type CreditNoteDto,
  type InvoiceDto,
  type InvoiceLineDto,
} from './billing.api';
import { BillingPage } from './billing-page';

const ALL = [
  'invoice.read',
  'invoice.manage',
  'invoice.issue',
  'credit_note.manage',
  'credit_note.issue',
  'contract.read',
  'contract.manage',
];

const invoiceLine = (over: Partial<InvoiceLineDto> = {}): InvoiceLineDto => ({
  id: 'il1',
  position: 1,
  salesOrderLineId: null,
  description: 'Consultoria',
  quantity: '2.000000',
  unitPrice: '50.0000',
  discountAmount: '0.0000',
  taxCode: 'IVA-14',
  taxRate: '14',
  exemptionReason: null,
  netAmount: '100.0000',
  taxAmount: '14.0000',
  total: '114.0000',
  ...over,
});

const invoice = (over: Partial<InvoiceDto> = {}): InvoiceDto => ({
  id: 'i1',
  organizationId: 'org1',
  customerId: 'c1',
  contractId: null,
  orderId: null,
  number: null,
  issuedOn: null,
  dueOn: '2099-01-01',
  currency: 'AOA',
  customerSnapshot: null,
  totals: { net: '100.0000', tax: '14.0000', total: '114.0000' },
  status: 'DRAFT',
  fiscalStatus: 'NOT_REQUIRED',
  notes: null,
  version: 1,
  lines: [invoiceLine()],
  ...over,
});

const issued = invoice({
  number: 'FT A/2026/1',
  status: 'ISSUED',
  issuedOn: '2026-10-28',
  customerSnapshot: {
    customerCode: 'CLI-001',
    name: 'Acme, Lda.',
    taxCountry: 'AO',
    taxId: '5000012345',
    billingAddress: {
      line1: 'Rua Direita 1',
      line2: null,
      city: 'Luanda',
      postalCode: null,
      countryCode: 'AO',
    },
  },
});

const note = (over: Partial<CreditNoteDto> = {}): CreditNoteDto => ({
  id: 'n1',
  invoiceId: 'i1',
  number: null,
  issuedOn: null,
  reason: 'Devolução',
  totals: { net: '50.0000', tax: '7.0000', total: '57.0000' },
  status: 'DRAFT',
  version: 1,
  lines: [
    {
      id: 'nl1',
      invoiceLineId: 'il1',
      quantity: '1.000000',
      amount: '50.0000',
      taxAmount: '7.0000',
    },
  ],
  ...over,
});

const contract = (over: Partial<ContractDto> = {}): ContractDto => ({
  id: 'k1',
  organizationId: 'org1',
  partyId: 'p1',
  type: 'SERVICE',
  title: 'Manutenção anual',
  number: null,
  startDate: '2026-01-01',
  endDate: '2099-12-31',
  currency: 'AOA',
  amount: '1200.0000',
  renewalMode: 'MANUAL',
  noticeDays: 30,
  status: 'DRAFT',
  effectiveStatus: 'DRAFT',
  noticeDeadline: '2099-12-01',
  terminateReason: null,
  notes: null,
  version: 1,
  ...over,
});

const order = (): OrderDto =>
  ({
    id: 'o1',
    number: 'ENC A/2026/1',
    status: 'PARTIAL',
    currency: 'AOA',
    totals: { net: '1000', tax: '0', total: '1000' },
  }) as OrderDto;

const billable = (over: Partial<BillableLine> = {}): BillableLine => ({
  orderLineId: 'ol1',
  description: 'Camisola',
  ordered: '10.000000',
  shipped: '4.000000',
  billed: '1.000000',
  billable: '3.000000',
  stockTracked: true,
  ...over,
});

const page = <T>(items: T[]) => ({ items, total: items.length });

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    invoices: vi.fn(() => of(page([invoice()]))),
    invoice: vi.fn(() => of(invoice())),
    billable: vi.fn(() =>
      of([
        billable(),
        billable({ orderLineId: 'ol2', description: 'Calças', billable: '0.000000' }),
      ]),
    ),
    creditNotes: vi.fn(() => of(page([note()]))),
    creditNote: vi.fn(() => of(note())),
    contracts: vi.fn(() => of(page([contract()]))),
    contract: vi.fn(() => of(contract())),
    parties: vi.fn(() => of([{ id: 'p1', displayName: 'Acme, Lda.' }])),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: BillingApi, useValue: full },
      {
        provide: OrdersApi,
        useValue: {
          orders: () => of(page([order()])),
          customers: () =>
            of([
              {
                id: 'c1',
                organizationId: 'org1',
                code: 'CLI-001',
                partyName: 'Acme, Lda.',
                currency: 'AOA',
              },
            ]),
        },
      },
    ],
  });
  return full;
}

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const mocked = configure(api, granted);
  const fixture = TestBed.createComponent(BillingPage);
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

describe('BillingPage', () => {
  it('mostra só os separadores permitidos', async () => {
    const { text } = await open({}, ['contract.read']);
    expect(text()).toContain('Contratos');
    expect(text()).not.toContain('Notas de crédito');
    expect(text()).toContain('Manutenção anual');
  });
});

describe('Facturas', () => {
  it('lista as facturas com o cliente, o estado e o total', async () => {
    const { text } = await open();
    expect(text()).toContain('Rascunho');
    expect(text()).toContain('Acme, Lda.');
    expect(text()).toContain('114,0000 AOA');
  });

  it('factura de uma encomenda: propõe o facturável, valida e cria o rascunho', async () => {
    const createInvoice = vi.fn(() => of(invoice({ orderId: 'o1' })));
    const { click, field, type, text } = await open({ createInvoice });
    await click('Nova factura');
    await click('Criar rascunho');
    expect(text()).toContain('Escolha a encomenda');
    await type(field('Encomenda'), 'o1');
    const inputs = document.body.querySelectorAll<HTMLInputElement>(
      '[data-testid=billable-lines] input',
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.value).toBe('3');
    await type(inputs[0]!, '4');
    await click('Criar rascunho');
    expect(text()).toContain('quantidade positiva até 3');
    expect(createInvoice).not.toHaveBeenCalled();
    await type(inputs[0]!, '2');
    await click('Criar rascunho');
    expect(createInvoice).toHaveBeenCalledWith({
      orderId: 'o1',
      lines: [{ orderLineId: 'ol1', quantity: '2' }],
    });
    expect(text()).toContain('Rascunho criado');
  });

  it('linhas livres: cria o rascunho do cliente e acrescenta uma linha validada', async () => {
    const createInvoice = vi.fn(() => of(invoice({ lines: [] })));
    const addInvoiceLine = vi.fn(() => of(invoice()));
    const { click, field, type, text } = await open({ createInvoice, addInvoiceLine });
    await click('Nova factura');
    await type(field('Origem'), 'free');
    await click('Criar rascunho');
    expect(text()).toContain('Escolha o cliente');
    await type(field('Cliente'), 'c1');
    await click('Criar rascunho');
    expect(createInvoice).toHaveBeenCalledWith({ organizationId: 'org1', customerId: 'c1' });
    await click('Adicionar linha');
    expect(text()).toContain('Indique a descrição');
    await type(field('Descrição'), 'Consultoria');
    await type(field('Preço sem imposto'), '50');
    await type(field('Taxa (%)'), '0');
    await click('Adicionar linha');
    expect(text()).toContain('exige o motivo da isenção');
    await type(field('Taxa (%)'), '14');
    await click('Adicionar linha');
    expect(addInvoiceLine).toHaveBeenCalledWith('i1', {
      description: 'Consultoria',
      quantity: '1',
      unitPrice: '50',
      taxRate: '14',
    });
  });

  it('emite o rascunho e mostra o número e o instantâneo do cliente; mostra o motivo se o servidor recusa', async () => {
    const issueInvoice = vi
      .fn()
      .mockReturnValueOnce(throwError(() => ({ code: 'INVOICE_NOT_ISSUABLE', message: 'x' })))
      .mockReturnValueOnce(of({ invoice: issued, idempotent: false }));
    const { click, text, buttons } = await open({ issueInvoice });
    await click('Abrir');
    expect(text()).toContain('Factura em rascunho');
    expect(document.body.querySelector('[data-testid=invoice-totals]')?.textContent).toContain(
      '114,0000',
    );
    await click('Emitir');
    expect(text()).toContain('já não pode ser emitida');
    await click('Emitir');
    expect(text()).toContain('Factura FT A/2026/1 emitida.');
    expect(document.body.querySelector('[data-testid=snapshot]')?.textContent).toContain(
      'NIF 5000012345',
    );
    expect(buttons('Emitir')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(0);
  });

  it('grava o vencimento alterado antes de emitir', async () => {
    const updateInvoice = vi.fn(() => of(invoice({ dueOn: '2099-02-02', version: 2 })));
    const issueInvoice = vi.fn(() => of({ invoice: issued, idempotent: false }));
    const { click, settle } = await open({ updateInvoice, issueInvoice });
    await click('Abrir');
    const due = document.body.querySelector<HTMLInputElement>('input[type=date]')!;
    due.value = '2099-02-02';
    due.dispatchEvent(new Event('change'));
    await settle();
    await click('Emitir');
    expect(updateInvoice).toHaveBeenCalledWith('i1', 1, '2099-02-02');
    expect(issueInvoice).toHaveBeenCalledWith('i1');
  });

  it('apaga um rascunho e respeita as permissões', async () => {
    const deleteInvoice = vi.fn(() => of(undefined));
    const first = await open({ deleteInvoice });
    await first.click('Abrir');
    await first.click('Apagar rascunho');
    expect(deleteInvoice).toHaveBeenCalledWith('i1');
    expect(first.text()).toContain('Rascunho apagado.');
  });

  it('sem manage não cria; sem issue não emite', async () => {
    const { buttons, click } = await open({}, ['invoice.read']);
    expect(buttons('Nova factura')).toHaveLength(0);
    await click('Abrir');
    expect(buttons('Emitir')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(0);
  });
});

describe('Notas de crédito', () => {
  const issuedInvoices = (over: Partial<InvoiceDto> = {}) => ({
    invoices: vi.fn(() => of(page([{ ...issued, ...over }]))),
    invoice: vi.fn(() => of({ ...issued, ...over })),
  });

  it('cria o rascunho com as quantidades a creditar e o motivo', async () => {
    const createCreditNote = vi.fn(() => of(note()));
    const { tab, click, field, type, text } = await open({ ...issuedInvoices(), createCreditNote });
    await tab('credit-notes');
    await click('Nova nota de crédito');
    await type(field('Factura'), 'i1');
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid=credit-lines] input',
    )!;
    await click('Criar rascunho');
    expect(text()).toContain('Indique o motivo');
    await type(field('Motivo'), 'Devolução');
    await click('Criar rascunho');
    expect(text()).toContain('pelo menos uma linha');
    await type(input, '1');
    await click('Criar rascunho');
    expect(createCreditNote).toHaveBeenCalledWith({
      invoiceId: 'i1',
      reason: 'Devolução',
      lines: [{ invoiceLineId: 'il1', quantity: '1' }],
    });
    expect(text()).toContain('Rascunho criado');
  });

  it('emite a nota e mostra os totais; apaga um rascunho', async () => {
    const issueCreditNote = vi.fn(() =>
      of({ creditNote: note({ number: 'NC A/2026/1', status: 'ISSUED' }), idempotent: false }),
    );
    const deleteCreditNote = vi.fn(() => of(undefined));
    const { tab, click, text, buttons } = await open({
      ...issuedInvoices(),
      issueCreditNote,
      deleteCreditNote,
    });
    await tab('credit-notes');
    await click('Abrir');
    expect(document.body.querySelector('[data-testid=note-totals]')?.textContent).toContain(
      '57,0000',
    );
    expect(text()).toContain('Consultoria × 1');
    await click('Emitir');
    expect(text()).toContain('Nota de crédito NC A/2026/1 emitida.');
    expect(buttons('Emitir')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(0);
  });

  it('mostra o limite creditável recusado pelo servidor', async () => {
    const createCreditNote = vi.fn(() =>
      throwError(() => ({
        code: 'VALIDATION_ERROR',
        fieldErrors: [{ code: 'EXCEEDS_CREDITABLE', message: 'm' }],
      })),
    );
    const { tab, click, field, type, text } = await open({ ...issuedInvoices(), createCreditNote });
    await tab('credit-notes');
    await click('Nova nota de crédito');
    await type(field('Factura'), 'i1');
    await type(field('Motivo'), 'x');
    await type(
      document.body.querySelector<HTMLInputElement>('[data-testid=credit-lines] input')!,
      '9',
    );
    await click('Criar rascunho');
    expect(text()).toContain('ultrapassa o que ainda falta creditar');
  });
});

describe('Contratos', () => {
  it('lista com o estado efectivo e activa um rascunho', async () => {
    const activateContract = vi.fn(() =>
      of({
        contract: contract({ number: 'CT A/2026/1', status: 'ACTIVE', effectiveStatus: 'ACTIVE' }),
        idempotent: false,
      }),
    );
    const { tab, click, text, buttons } = await open(
      {
        activateContract,
        contracts: vi.fn(() =>
          of(
            page([
              contract(),
              contract({ id: 'k2', title: 'Antigo', status: 'ACTIVE', effectiveStatus: 'EXPIRED' }),
            ]),
          ),
        ),
      },
      ['contract.read', 'contract.manage'],
    );
    await tab('contracts');
    expect(text()).toContain('Expirado');
    await click('Abrir');
    expect(text()).toContain('Aviso de não renovação até');
    await click('Activar');
    expect(text()).toContain('Contrato CT A/2026/1 activado.');
    expect(buttons('Activar')).toHaveLength(0);
  });

  it('termina um contrato activo com motivo', async () => {
    const active = contract({ number: 'CT A/2026/1', status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    const terminateContract = vi.fn(() =>
      of({
        contract: contract({
          status: 'TERMINATED',
          effectiveStatus: 'TERMINATED',
          terminateReason: 'Fim acordado',
        }),
        idempotent: false,
      }),
    );
    const { click, field, type, text } = await open(
      {
        terminateContract,
        contracts: vi.fn(() => of(page([active]))),
        contract: vi.fn(() => of(active)),
      },
      ['contract.read', 'contract.manage'],
    );
    await click('Abrir');
    await click('Terminar');
    expect(text()).toContain('Indique o motivo do fim');
    await type(field('Motivo do fim'), 'Fim acordado');
    await click('Terminar');
    expect(terminateContract).toHaveBeenCalledWith('k1', 'Fim acordado');
    expect(text()).toContain('Contrato terminado.');
  });

  it('cria um rascunho validando datas e escolhendo a contraparte', async () => {
    const createContract = vi.fn(() => of(contract()));
    const { click, field, type, text } = await open({ createContract }, [
      'contract.read',
      'contract.manage',
    ]);
    await click('Novo contrato');
    await click('Criar rascunho');
    expect(text()).toContain('Escolha a contraparte');
    await type(field('Procurar contraparte'), 'Ac');
    await type(field('Contraparte'), 'p1');
    await click('Criar rascunho');
    expect(text()).toContain('Indique o título');
    await type(field('Título'), 'Manutenção anual');
    await type(field('Início (AAAA-MM-DD)'), '2026-02-30');
    await click('Criar rascunho');
    expect(text()).toContain('Início inválido');
    await type(field('Início (AAAA-MM-DD)'), '2026-01-01');
    await type(field('Valor'), '1200');
    await click('Criar rascunho');
    expect(createContract).toHaveBeenCalledWith({
      organizationId: 'org1',
      partyId: 'p1',
      type: 'SERVICE',
      title: 'Manutenção anual',
      startDate: '2026-01-01',
      endDate: null,
      amount: '1200',
      renewalMode: 'NONE',
      noticeDays: 0,
    });
    expect(text()).toContain('Rascunho criado');
  });

  it('sem manage não cria nem activa', async () => {
    const { buttons, click } = await open({}, ['contract.read']);
    expect(buttons('Novo contrato')).toHaveLength(0);
    await click('Abrir');
    expect(buttons('Activar')).toHaveLength(0);
  });
});
