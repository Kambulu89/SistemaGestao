import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import {
  OrdersApi,
  type CustomerOption,
  type LineDto,
  type OrderDto,
  type QuoteDto,
} from './orders.api';
import { OrdersPage } from './orders-page';

const customer: CustomerOption = {
  id: 'c1',
  organizationId: 'o1',
  code: 'CLI-001',
  partyName: 'Acme, Lda.',
  currency: 'AOA',
};

const line = (over: Partial<LineDto> = {}): LineDto => ({
  id: 'l1',
  position: 1,
  variantId: 'v1',
  descriptionSnapshot: 'Camisola — CAM-001',
  quantity: '2.000000',
  unitPrice: '1500.0000',
  discountRate: '0.0000',
  taxRateSnapshot: '14.0000',
  netAmount: '3000.0000',
  taxAmount: '420.0000',
  total: '3420.0000',
  priceOrigin: {
    priceListName: 'Retalho',
    priority: 0,
    minQuantity: '1.000000',
    maxDiscount: '0.1000',
    taxInclusive: false,
  },
  ...over,
});

const totals = { net: '3000.0000', tax: '420.0000', total: '3420.0000' };

const quote = (over: Partial<QuoteDto> = {}): QuoteDto => ({
  id: 'q1',
  organizationId: 'o1',
  customerId: 'c1',
  number: null,
  validUntil: '2026-12-31',
  currency: 'AOA',
  status: 'DRAFT',
  notes: null,
  totals,
  version: 1,
  lines: [line()],
  ...over,
});

const order = (over: Partial<OrderDto> = {}): OrderDto => ({
  id: 'r1',
  organizationId: 'o1',
  customerId: 'c1',
  quoteId: null,
  number: null,
  orderDate: '2026-10-27',
  currency: 'AOA',
  status: 'DRAFT',
  deliveryAddress: null,
  creditReservation: '0.0000',
  totals,
  confirmedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  lines: [line()],
  ...over,
});

const ALL = ['quote.read', 'quote.manage', 'order.read', 'order.manage', 'sales.confirm'];

async function render(api: Partial<OrdersApi> = {}, granted: readonly string[] = ALL) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      {
        provide: OrdersApi,
        useValue: {
          customers: () => of([customer]),
          quotes: () =>
            of({ items: [quote({ number: 'PRO A/2026/1', status: 'SENT' })], total: 1 }),
          quote: () => of(quote()),
          orders: () => of({ items: [order()], total: 1 }),
          order: () => of(order()),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(OrdersPage);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const field = (label: string) => {
    const lab = [...el.querySelectorAll('label')].find((l) =>
      l.textContent?.trim().startsWith(label),
    );
    return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`)!;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  const click = async (label: string) => {
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click();
    await settle();
    await settle();
  };
  const tab = async (id: string) => {
    el.querySelector<HTMLButtonElement>(`[data-testid=tab-${id}]`)!.click();
    await settle();
    await settle();
  };
  const has = (label: string) =>
    [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
  return { el, type, click, tab, has };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Propostas', () => {
  it('lista o número, o cliente, a validade, o total com a moeda e o estado', async () => {
    const { el } = await render();
    const row = text(el.querySelector('[data-testid=quotes] tbody tr'));
    expect(row).toContain('PRO A/2026/1');
    expect(row).toContain('Acme, Lda.');
    expect(row).toContain('2026-12-31');
    expect(row).toContain('3 420,0000 AOA'.replace(' ', ' '));
    expect(row).toContain('Enviada');
  });

  it('cria uma proposta com a organização do cliente escolhido', async () => {
    const createQuote = vi.fn(() => of(quote({ lines: [] })));
    const { click, type } = await render({ createQuote });
    await click('Nova proposta');
    await type('Cliente', 'c1');
    await type('Válida até', '2026-12-31');
    await click('Criar proposta');
    expect(createQuote).toHaveBeenCalledWith({
      organizationId: 'o1',
      customerId: 'c1',
      validUntil: '2026-12-31',
    });
  });

  it('acrescenta uma linha por SKU, com a quantidade em texto, e mostra o que o servidor calculou', async () => {
    const variantIdBySku = vi.fn(() => of('v1'));
    const updated = quote({
      lines: [line(), line({ id: 'l2', position: 2, quantity: '12.000000', total: '18468.0000' })],
      totals: { net: '19200.0000', tax: '2688.0000', total: '21888.0000' },
    });
    const addQuoteLine = vi.fn(() => of(updated));
    const { el, click, type } = await render({ variantIdBySku, addQuoteLine });
    await click('Abrir');
    await type('SKU da variante', 'CAM-001');
    await type('Quantidade', '12');
    await type('Desconto', '0.05');
    await click('Acrescentar linha');
    expect(variantIdBySku).toHaveBeenCalledWith('CAM-001');
    expect(addQuoteLine).toHaveBeenCalledWith('q1', {
      variantId: 'v1',
      quantity: '12',
      discountRate: '0.05',
    });
    expect(el.querySelectorAll('[data-testid=lines] tbody tr').length).toBe(2);
    expect(text(el.querySelector('[data-testid=totals]'))).toContain('21 888,0000 AOA');
  });

  it('quantidade inválida ou desconto acima de 1 são recusados antes de chamar o servidor', async () => {
    const addQuoteLine = vi.fn();
    const { el, click, type } = await render({ addQuoteLine });
    await click('Abrir');
    await type('SKU da variante', 'CAM-001');
    await type('Quantidade', '0');
    await click('Acrescentar linha');
    expect(el.textContent).toContain('Quantidade: número positivo');
    await type('Quantidade', '1');
    await type('Desconto', '1.5');
    await click('Acrescentar linha');
    expect(el.textContent).toContain('Desconto: um valor entre 0 e 1');
    expect(addQuoteLine).not.toHaveBeenCalled();
  });

  it('só um rascunho se envia; só uma enviada se aceita ou rejeita; aceitar avisa da encomenda criada', async () => {
    const sendQuote = vi.fn(() => of(quote({ status: 'SENT', number: 'PRO A/2026/2' })));
    const acceptQuote = vi.fn(() =>
      of({ quote: quote({ status: 'ACCEPTED' }), order: order(), idempotent: false }),
    );
    const { el, click, has } = await render({ sendQuote, acceptQuote });
    await click('Abrir');
    expect(has('Enviar')).toBe(true);
    expect(has('Aceitar e criar encomenda')).toBe(false);
    await click('Enviar');
    expect(sendQuote).toHaveBeenCalledWith('q1');
    expect(has('Aceitar e criar encomenda')).toBe(true);
    expect(has('Rejeitar')).toBe(true);
    await click('Aceitar e criar encomenda');
    expect(acceptQuote).toHaveBeenCalledWith('q1');
    expect(el.textContent).toContain('Foi criada uma encomenda em rascunho');
    expect(has('Aceitar e criar encomenda')).toBe(false);
  });

  it('sem quote.manage não há criar, enviar nem editar linhas', async () => {
    const { has, click, el } = await render({}, ['quote.read']);
    expect(has('Nova proposta')).toBe(false);
    await click('Abrir');
    expect(has('Enviar')).toBe(false);
    expect(el.textContent).not.toContain('Nova linha');
  });

  it('mostra a mensagem própria quando falta a sequência de numeração', async () => {
    const sendQuote = vi.fn(() =>
      throwError(() => ({ status: 409, code: 'SEQUENCE_NOT_CONFIGURED', message: 'x' })),
    );
    const { el, click } = await render({ sendQuote });
    await click('Abrir');
    await click('Enviar');
    expect(el.textContent).toContain('sequência de numeração');
  });
});

describe('Encomendas', () => {
  it('confirmar mostra o número e avisa que a expedição baixa o stock e a factura é à parte', async () => {
    const confirmOrder = vi.fn(() =>
      of({
        order: order({
          status: 'CONFIRMED',
          number: 'ENC A/2026/1',
          confirmedAt: '2026-10-27T10:00:00Z',
        }),
        idempotent: false,
      }),
    );
    const { el, click, tab, has } = await render({ confirmOrder });
    await tab('orders');
    await click('Abrir');
    await click('Confirmar');
    expect(confirmOrder).toHaveBeenCalledWith('r1');
    expect(el.textContent).toContain('ENC A/2026/1');
    expect(el.textContent).toContain('A expedição (separador «Expedições») baixa o stock');
    expect(has('Confirmar')).toBe(false);
  });

  it('um cliente bloqueado recusa a confirmação com a mensagem própria', async () => {
    const confirmOrder = vi.fn(() =>
      throwError(() => ({ status: 409, code: 'CUSTOMER_BLOCKED', message: 'x' })),
    );
    const { el, click, tab } = await render({ confirmOrder });
    await tab('orders');
    await click('Abrir');
    await click('Confirmar');
    expect(el.textContent).toContain('O cliente está bloqueado');
  });

  it('cancelar exige motivo', async () => {
    const cancelOrder = vi.fn(() =>
      of({ order: order({ status: 'CANCELLED', cancelReason: 'Desistência' }), idempotent: false }),
    );
    const { el, click, type, tab } = await render({ cancelOrder });
    await tab('orders');
    await click('Abrir');
    await click('Cancelar encomenda');
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indique o motivo do cancelamento');
    await type('Motivo do cancelamento', 'Desistência');
    await click('Cancelar encomenda');
    expect(cancelOrder).toHaveBeenCalledWith('r1', 'Desistência');
    expect(el.textContent).toContain('Cancelada: Desistência');
  });

  it('sem sales.confirm não há confirmar nem cancelar; sem order.manage as linhas não se editam', async () => {
    const { el, click, tab, has } = await render({}, ['order.read', 'order.manage']);
    await tab('orders');
    await click('Abrir');
    expect(has('Confirmar')).toBe(false);
    expect(has('Cancelar encomenda')).toBe(false);
    expect(el.textContent).toContain('Nova linha');
  });

  it('guarda a morada de entrega como instantâneo de campos simples', async () => {
    const updateOrder = vi.fn(() =>
      of(
        order({
          version: 2,
          deliveryAddress: { line1: 'Rua A, 1', city: 'Luanda', countryCode: 'AO' },
        }),
      ),
    );
    const { click, type, tab } = await render({ updateOrder });
    await tab('orders');
    await click('Abrir');
    await type('Morada', 'Rua A, 1');
    await type('Cidade', 'Luanda');
    await type('País', 'ao');
    await click('Guardar morada');
    expect(updateOrder).toHaveBeenCalledWith('r1', 1, {
      deliveryAddress: { line1: 'Rua A, 1', city: 'Luanda', countryCode: 'AO' },
    });
  });
});
