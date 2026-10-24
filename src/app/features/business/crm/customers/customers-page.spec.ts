import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { IamApi } from '../../../tenant/data-access/iam.api';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { CustomersApi, type CustomerDto, type InteractionDto } from './customers.api';
import { CustomersPage } from './customers-page';

const customer = (over: Partial<CustomerDto> = {}): CustomerDto => ({
  id: 'c1',
  partyId: 'p1',
  organizationId: 'o1',
  code: 'CLI-001',
  segmentId: null,
  accountManagerMembershipId: null,
  paymentTermDays: 30,
  creditLimit: '1000.0000',
  currency: 'AOA',
  status: 'ACTIVE',
  statusReason: null,
  version: 1,
  partyName: 'Acme, Lda.',
  partyKind: 'ORGANIZATION',
  taxId: '5000012345',
  segmentName: null,
  ...over,
});

const interaction = (over: Partial<InteractionDto> = {}): InteractionDto => ({
  id: 'i1',
  partyId: 'p1',
  channel: 'CALL',
  subject: 'Primeiro contacto',
  occurredAt: '2026-10-20T09:00:00.000Z',
  ownerMembershipId: 'm1',
  summary: 'Interessada.',
  followUpAt: null,
  version: 1,
  ...over,
});

const ALL = [
  'customer.read',
  'customer.create',
  'customer.update',
  'customer.block',
  'customer.credit_manage',
];

async function render(api: Partial<CustomersApi> = {}, granted: readonly string[] = ALL) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      {
        provide: CustomersApi,
        useValue: {
          segments: () => of([]),
          customers: () => of({ items: [customer()], total: 1 }),
          customer: () => of({ ...customer(), contacts: [] }),
          interactions: () => of([interaction()]),
          ...api,
        },
      },
      {
        provide: OrganizationApi,
        useValue: {
          listOrganizations: () =>
            of([
              {
                id: 'o1',
                code: 'EMP',
                legalName: 'Empresa, Lda.',
                tradeName: null,
                countryCode: 'AO',
                baseCurrency: 'AOA',
                active: true,
                version: 1,
              },
            ]),
        },
      },
      { provide: IamApi, useValue: { listMembers: () => of([]) } },
    ],
  });
  const fixture = TestBed.createComponent(CustomersPage);
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
    return el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${lab?.htmlFor}`);
  };
  const type = async (label: string, value: string) => {
    const input = field(label)!;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await settle();
  };
  const click = async (label: string) => {
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click();
    await settle();
    await settle();
  };
  return { el, settle, field, type, click };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('Clientes', () => {
  it('lista o nome da Party, o código, o NIF, o prazo e o crédito', async () => {
    const { el } = await render();
    const row = text(el.querySelector('[data-testid=customers] tbody tr'));
    expect(row).toContain('Acme, Lda.');
    expect(row).toContain('CLI-001 · NIF 5000012345');
    expect(row).toContain('30 dias');
    expect(row).toContain('1000.0000 AOA');
    expect(row).toContain('Activo');
  });

  it('sem crédito no servidor (null) a lista mostra um traço e o formulário não oferece o limite', async () => {
    const { el, click, field } = await render(
      { customers: () => of({ items: [customer({ creditLimit: null })], total: 1 }) },
      ['customer.read', 'customer.update'],
    );
    expect(text(el.querySelector('[data-testid=customers] tbody tr'))).not.toContain('AOA');
    await click('Abrir');
    expect(field('Limite de crédito')).toBeNull();
    expect(field('Prazo de pagamento')).not.toBeNull();
  });

  it('regista um cliente sobre uma Party encontrada, sem a criar de novo', async () => {
    const createCustomer = vi.fn(() => of(customer({ id: 'c2', code: 'CLI-002' })));
    const searchParties = vi.fn(() =>
      of([{ id: 'p9', kind: 'ORGANIZATION' as const, displayName: 'Acme, Lda.' }]),
    );
    const createOrganizationParty = vi.fn();
    const { click, type } = await render({
      createCustomer,
      searchParties,
      createOrganizationParty,
    });
    await click('Novo cliente');
    await type('Procurar', 'Acme');
    await type('Resultado', 'p9');
    await type('Organização', 'o1');
    await type('Código', 'CLI-002');
    await type('Limite de crédito', '2500.5');
    await click('Guardar');
    expect(searchParties).toHaveBeenCalledWith('Acme');
    expect(createOrganizationParty).not.toHaveBeenCalled();
    expect(createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        partyId: 'p9',
        organizationId: 'o1',
        code: 'CLI-002',
        creditLimit: '2500.5',
      }),
    );
  });

  it('a criação guiada cria primeiro a organização e depois o cliente', async () => {
    const order: string[] = [];
    const createOrganizationParty = vi.fn(() => {
      order.push('party');
      return of({ id: 'p10', displayName: 'Nova, Lda.' });
    });
    const createCustomer = vi.fn(() => {
      order.push('customer');
      return of(customer({ id: 'c3' }));
    });
    const { click, type } = await render({ createOrganizationParty, createCustomer });
    await click('Novo cliente');
    await type('Pessoa ou organização', 'organization');
    await type('Designação legal', 'Nova, Lda.');
    await type('NIF', '5000099999');
    await type('Organização', 'o1');
    await type('Código', 'CLI-3');
    await click('Guardar');
    expect(order).toEqual(['party', 'customer']);
    expect(createOrganizationParty).toHaveBeenCalledWith({
      legalName: 'Nova, Lda.',
      taxId: '5000099999',
      taxCountry: 'AO',
    });
    expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({ partyId: 'p10' }));
  });

  it('um limite de crédito com mais de 4 casas é recusado antes de chamar o servidor', async () => {
    const createCustomer = vi.fn();
    const { el, click, type } = await render({ createCustomer });
    await click('Novo cliente');
    await type('Pessoa ou organização', 'person');
    await type('Nomes próprios', 'Maria');
    await type('Apelido', 'Silva');
    await type('Organização', 'o1');
    await type('Código', 'CLI-4');
    await type('Limite de crédito', '10.12345');
    await click('Guardar');
    expect(createCustomer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('até 4 casas');
  });

  it('bloquear exige motivo; um cliente bloqueado mostra o motivo e oferece desbloquear', async () => {
    const block = vi.fn(() =>
      of(customer({ status: 'BLOCKED', statusReason: 'Dívida', version: 2 })),
    );
    const unblock = vi.fn(() => of(customer({ version: 3 })));
    const { el, click, type } = await render({ block, unblock });
    await click('Abrir');
    await click('Bloquear cliente');
    expect(block).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indique o motivo do bloqueio.');
    await type('Motivo do bloqueio', 'Dívida');
    await click('Bloquear cliente');
    expect(block).toHaveBeenCalledWith('c1', 1, 'Dívida');
    expect(el.textContent).toContain('Cliente bloqueado');
    expect(el.textContent).toContain('continua a poder pagar');
    await click('Desbloquear');
    expect(unblock).toHaveBeenCalledWith('c1', 2);
  });

  it('sem customer.block não há botões de bloqueio', async () => {
    const { el, click } = await render({}, ['customer.read', 'customer.update']);
    await click('Abrir');
    expect(el.textContent).not.toContain('Bloquear cliente');
  });

  it('regista interacções sobre a Party do cliente e mostra-as primeiro', async () => {
    const createInteraction = vi.fn(() =>
      of(interaction({ id: 'i2', subject: 'Proposta enviada', channel: 'EMAIL' })),
    );
    const { el, click, type } = await render({ createInteraction });
    await click('Abrir');
    expect(text(el.querySelector('[data-testid=interactions]'))).toContain('Primeiro contacto');
    await type('Assunto', 'Proposta enviada');
    await type('Canal', 'EMAIL');
    await click('Registar interacção');
    expect(createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ partyId: 'p1', channel: 'EMAIL', subject: 'Proposta enviada' }),
    );
    const items = [...el.querySelectorAll('[data-testid=interactions] li')].map((li) => text(li));
    expect(items[0]).toContain('Proposta enviada');
    expect(items[1]).toContain('Primeiro contacto');
  });

  it('mostra a mensagem própria quando a Party já é cliente', async () => {
    const createCustomer = vi.fn(() =>
      throwError(() => ({ status: 409, code: 'CUSTOMER_EXISTS', message: 'x' })),
    );
    const searchParties = vi.fn(() =>
      of([{ id: 'p9', kind: 'ORGANIZATION' as const, displayName: 'Acme, Lda.' }]),
    );
    const { el, click, type } = await render({ createCustomer, searchParties });
    await click('Novo cliente');
    await type('Procurar', 'Acme');
    await type('Resultado', 'p9');
    await type('Organização', 'o1');
    await type('Código', 'CLI-5');
    await click('Guardar');
    expect(el.textContent).toContain('já é cliente desta organização');
  });
});
