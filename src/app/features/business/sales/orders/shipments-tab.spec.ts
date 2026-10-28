import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { OrdersApi, type LineDto, type OrderDto, type ShipmentDto } from './orders.api';
import { ShipmentsTab } from './shipments-tab';

const ALL = ['shipment.read', 'shipment.manage', 'shipment.post'];

const line = (over: Partial<LineDto> = {}): LineDto =>
  ({
    id: 'l1',
    position: 1,
    variantId: 'v1',
    descriptionSnapshot: 'Camisola — CAM-001',
    quantity: '10.000000',
    shippedQty: '4.000000',
    ...over,
  }) as LineDto;

const order = (over: Partial<OrderDto> = {}): OrderDto =>
  ({
    id: 'o1',
    number: 'ENC A/2026/1',
    status: 'PARTIAL',
    lines: [
      line(),
      line({
        id: 'l2',
        descriptionSnapshot: 'Calças — CAL-001',
        quantity: '2.000000',
        shippedQty: '2.000000',
      }),
    ],
    ...over,
  }) as OrderDto;

const shipment = (over: Partial<ShipmentDto> = {}): ShipmentDto => ({
  id: 's1',
  orderId: 'o1',
  number: null,
  status: 'DRAFT',
  notes: null,
  shippedAt: null,
  reversedAt: null,
  reverseReason: null,
  version: 1,
  lines: [{ id: 'sl1', shipmentId: 's1', orderLineId: 'l1', quantity: '6.000000', version: 1 }],
  ...over,
});

const page = <T>(items: T[]) => ({ items, total: items.length });

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    shipments: vi.fn(() =>
      of(
        page([
          shipment({ number: 'EXP A/2026/1', status: 'POSTED', shippedAt: '2026-10-28T10:00:00Z' }),
        ]),
      ),
    ),
    orders: vi.fn(() => of(page([order()]))),
    order: vi.fn(() => of(order())),
    shipment: vi.fn(() => of(shipment())),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: OrdersApi, useValue: full },
    ],
  });
  return full;
}

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const mocked = configure(api, granted);
  const fixture = TestBed.createComponent(ShipmentsTab);
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
  return { mocked, settle, buttons, click, text, field, type };
}

describe('ShipmentsTab', () => {
  it('lista as expedições com o número da encomenda e o estado', async () => {
    const { text } = await open();
    expect(text()).toContain('EXP A/2026/1');
    expect(text()).toContain('ENC A/2026/1');
    expect(text()).toContain('Lançada');
  });

  it('propõe o saldo por expedir de cada linha e cria o rascunho com as quantidades', async () => {
    const createShipment = vi.fn(() => of(shipment()));
    const { click, field, type, text } = await open({ createShipment });
    await click('Nova expedição');
    await type(field('Encomenda'), 'o1');
    // Só a primeira linha tem saldo (6 por expedir); a segunda já foi toda expedida.
    const inputs = document.body.querySelectorAll<HTMLInputElement>(
      '[data-testid=ship-lines] input',
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.value).toBe('6');
    await click('Criar rascunho');
    expect(createShipment).toHaveBeenCalledWith({
      orderId: 'o1',
      lines: [{ orderLineId: 'l1', quantity: '6' }],
    });
    expect(text()).toContain('Rascunho criado');
  });

  it('recusa localmente uma quantidade acima do saldo, zero ou sem linhas', async () => {
    const createShipment = vi.fn(() => of(shipment()));
    const { click, field, type, text } = await open({ createShipment });
    await click('Nova expedição');
    await click('Criar rascunho');
    expect(text()).toContain('Escolha a encomenda');
    await type(field('Encomenda'), 'o1');
    const input = () =>
      document.body.querySelector<HTMLInputElement>('[data-testid=ship-lines] input')!;
    await type(input(), '7');
    await click('Criar rascunho');
    expect(text()).toContain('quantidade positiva até 6');
    await type(input(), '0');
    await click('Criar rascunho');
    expect(text()).toContain('pelo menos uma linha');
    expect(createShipment).not.toHaveBeenCalled();
  });

  it('lança o rascunho e mostra o número; mostra o motivo quando o servidor recusa', async () => {
    const postShipment = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => ({
          code: 'SHIPMENT_NOT_POSTABLE',
          message: 'A expedição não pode ser lançada.',
          fieldErrors: [
            {
              path: 'lines[0].quantity',
              code: 'INSUFFICIENT_STOCK',
              message: 'Stock insuficiente: faltam 3.000000.',
            },
          ],
        })),
      )
      .mockReturnValueOnce(
        of({ shipment: shipment({ number: 'EXP A/2026/2', status: 'POSTED' }), idempotent: false }),
      );
    const { click, text, buttons } = await open({ postShipment });
    await click('Abrir');
    expect(text()).toContain('Expedição em rascunho');
    expect(text()).toContain('Camisola — CAM-001');
    await click('Lançar');
    expect(text()).toContain('Stock insuficiente: faltam 3.000000.');
    await click('Lançar');
    expect(text()).toContain('Expedição EXP A/2026/2 lançada: o stock foi baixado.');
    expect(buttons('Lançar')).toHaveLength(0);
  });

  it('reverte uma expedição lançada com motivo', async () => {
    const reverseShipment = vi.fn(() =>
      of({
        shipment: shipment({
          number: 'EXP A/2026/1',
          status: 'REVERSED',
          reverseReason: 'Devolvida',
        }),
        idempotent: false,
      }),
    );
    const { click, field, type, text } = await open({
      reverseShipment,
      shipment: () =>
        of(
          shipment({ number: 'EXP A/2026/1', status: 'POSTED', shippedAt: '2026-10-28T10:00:00Z' }),
        ),
    });
    await click('Abrir');
    await click('Reverter');
    expect(text()).toContain('Indique o motivo da reversão');
    expect(reverseShipment).not.toHaveBeenCalled();
    await type(field('Motivo da reversão'), 'Devolvida');
    await click('Reverter');
    expect(reverseShipment).toHaveBeenCalledWith('s1', 'Devolvida');
    expect(text()).toContain('Revertida');
    expect(text()).toContain('o stock foi reposto');
  });

  it('apaga um rascunho', async () => {
    const deleteShipment = vi.fn(() => of(undefined));
    const { click, text } = await open({ deleteShipment });
    await click('Abrir');
    await click('Apagar rascunho');
    expect(deleteShipment).toHaveBeenCalledWith('s1');
    expect(text()).toContain('Rascunho apagado.');
  });

  it('respeita as permissões: sem manage não cria nem apaga; sem post não lança nem reverte', async () => {
    const { buttons, click } = await open({}, ['shipment.read']);
    expect(buttons('Nova expedição')).toHaveLength(0);
    await click('Abrir');
    expect(buttons('Lançar')).toHaveLength(0);
    expect(buttons('Apagar rascunho')).toHaveLength(0);
  });
});
