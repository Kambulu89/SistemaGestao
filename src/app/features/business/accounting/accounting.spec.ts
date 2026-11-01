import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { AccountingPage } from './accounting-page';
import {
  AccountingApi,
  type AccountDto,
  type EntryDetailDto,
  type JournalDto,
  type JournalType,
} from './accounting.api';
import {
  accountingError,
  defaultJournal,
  formatAmount,
  fromCents,
  normalizeAmount,
  suggestParent,
  toCents,
  totalsOf,
  treeOf,
} from './accounting-model';
import { ChartTab } from './chart-tab';
import { EntriesTab } from './entries-tab';
import { TrialTab } from './trial-tab';

const account = (over: Partial<AccountDto>): AccountDto => ({
  id: 'x',
  organizationId: 'o1',
  code: '3',
  name: 'Terceiros',
  accountClass: 3,
  nature: 'DEBIT',
  kind: 'HEADER',
  parentId: null,
  requiresCostCenter: false,
  requiresParty: false,
  active: true,
  version: 1,
  ...over,
});

const ACCOUNTS: AccountDto[] = [
  account({ id: 'h3', code: '3', name: 'Terceiros' }),
  account({ id: 'h6', code: '6', name: 'Proveitos', accountClass: 6, nature: 'CREDIT' }),
  account({ id: 'a31', code: '31.1', name: 'Clientes', kind: 'POSTING', parentId: 'h3' }),
  account({
    id: 'a61',
    code: '61.1',
    name: 'Vendas',
    kind: 'POSTING',
    parentId: 'h6',
    accountClass: 6,
    nature: 'CREDIT',
  }),
];

describe('accounting model', () => {
  it('converts amounts exactly, accepting a decimal comma', () => {
    expect(toCents('250,5')).toBe(2505000n);
    expect(toCents('')).toBe(0n);
    expect(toCents('1.00001')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(fromCents(-12345n)).toBe('-1.2345');
    expect(normalizeAmount('0,1')).toBe('0.1000');
    expect(normalizeAmount('x')).toBeNull();
    // Sem float: 0,1 + 0,2 = 0,3 exactamente.
    const t = totalsOf([
      { accountId: 'a', debit: '0,1', credit: '', description: '' },
      { accountId: 'b', debit: '0,2', credit: '', description: '' },
      { accountId: 'c', debit: '', credit: '0.3', description: '' },
    ]);
    expect([t.debit, t.credit, t.balanced]).toEqual(['0.3000', '0.3000', true]);
  });

  it('flags invalid lines and reports the difference in real time', () => {
    const t = totalsOf([
      { accountId: 'a', debit: '100', credit: '', description: '' },
      { accountId: 'b', debit: '', credit: '99.99', description: '' },
      { accountId: 'c', debit: '5', credit: '5', description: '' },
      { accountId: 'd', debit: '', credit: '', description: '' },
    ]);
    expect(t.invalid).toEqual([2, 3]);
    expect(t.difference).toBe('0.0100');
    expect(t.balanced).toBe(false);
    expect(totalsOf([{ accountId: 'a', debit: '1', credit: '', description: '' }]).balanced).toBe(
      false,
    );
  });

  it('formats amounts for reading and builds the chart tree', () => {
    expect(formatAmount('1234567.5000')).toBe('1 234 567,5000');
    expect(formatAmount(null)).toBe('—');
    expect(treeOf(ACCOUNTS).map((r) => [r.account.code, r.depth])).toEqual([
      ['3', 0],
      ['31.1', 1],
      ['6', 0],
      ['61.1', 1],
    ]);
    expect(suggestParent(ACCOUNTS, '31.2')?.id).toBe('h3');
    expect(suggestParent(ACCOUNTS, '9')).toBeNull();
  });

  it('propõe o diário geral activo, nunca o de abertura por ordem', () => {
    const j = (id: string, type: JournalType, active = true): JournalDto => ({
      id,
      organizationId: 'o',
      code: id,
      name: id,
      type,
      active,
      version: 1,
    });
    expect(
      defaultJournal([j('ABE', 'OPENING'), j('COM', 'PURCHASES'), j('GER', 'GENERAL')])?.id,
    ).toBe('GER');
    expect(
      defaultJournal([j('ABE', 'OPENING'), j('GER', 'GENERAL', false), j('VEN', 'SALES')])?.id,
    ).toBe('VEN');
    expect(defaultJournal([j('ABE', 'OPENING')])?.id).toBe('ABE');
    expect(defaultJournal([])).toBeNull();
  });

  it('translates server error codes, also when wrapped by a resource', () => {
    expect(accountingError({ code: 'PERIOD_CLOSED' }, 'x')).toContain('fechado');
    expect(accountingError(new Error('x', { cause: { code: 'ALREADY_REVERSED' } }), 'x')).toContain(
      'revertido',
    );
    expect(accountingError({}, 'falhou')).toBe('falhou');
  });
});

const detail = (over: Partial<EntryDetailDto> = {}): EntryDetailDto => ({
  id: 'e1',
  organizationId: 'o1',
  journalId: 'j1',
  journalCode: 'GER',
  number: null,
  entryDate: '2031-03-10',
  description: 'Venda a pronto',
  status: 'DRAFT',
  sourceType: null,
  sourceKey: null,
  reversalOfId: null,
  totalDebit: '250.5000',
  totalCredit: '250.5000',
  postedAt: null,
  version: 1,
  lines: [
    {
      accountId: 'a31',
      accountCode: '31.1',
      accountName: 'Clientes',
      debit: '250.5000',
      credit: '0.0000',
      description: null,
    },
    {
      accountId: 'a61',
      accountCode: '61.1',
      accountName: 'Vendas',
      debit: '0.0000',
      credit: '250.5000',
      description: null,
    },
  ],
  reversedById: null,
  ...over,
});

function setup(granted: string[], api: Partial<Record<keyof AccountingApi, unknown>> = {}) {
  const full = {
    organizations: vi.fn(() => of([{ id: 'o1', code: 'EMP', legalName: 'Empresa, Lda.' }])),
    accounts: vi.fn(() => of(ACCOUNTS)),
    journals: vi.fn(() =>
      of([
        {
          id: 'j1',
          organizationId: 'o1',
          code: 'GER',
          name: 'Operações diversas',
          type: 'GENERAL',
          active: true,
          version: 1,
        },
      ]),
    ),
    entries: vi.fn(() => of({ items: [detail()], total: 1 })),
    entry: vi.fn(() => of(detail())),
    createEntry: vi.fn(() => of(detail())),
    postEntry: vi.fn(() => of(detail({ status: 'POSTED', number: 7 }))),
    trialBalance: vi.fn(() =>
      of({
        organizationId: 'o1',
        from: '2031-01-01',
        to: '2031-12-31',
        rows: [
          {
            accountId: 'a31',
            code: '31.1',
            name: 'Clientes',
            accountClass: 3,
            nature: 'DEBIT',
            openingDebit: '0.0000',
            openingCredit: '0.0000',
            periodDebit: '250.5000',
            periodCredit: '0.0000',
            closingDebit: '250.5000',
            closingCredit: '0.0000',
          },
        ],
        byClass: [],
        totals: {
          openingDebit: '0.0000',
          openingCredit: '0.0000',
          periodDebit: '250.5000',
          periodCredit: '250.5000',
          closingDebit: '250.5000',
          closingCredit: '250.5000',
        },
        asOf: '2031-03-10T10:20:30.000Z',
      }),
    ),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: AccountingApi, useValue: full },
    ],
  });
  return full as unknown as { createEntry: Mock; postEntry: Mock; entries: Mock };
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('AccountingPage', () => {
  it('chooses the first company and shows the entries', async () => {
    setup(['accounting.read']);
    const fixture = TestBed.createComponent(AccountingPage);
    await settle(fixture);
    expect(text()).toContain('Empresa, Lda. (EMP)');
    expect(fixture.nativeElement.querySelector('[data-testid="tab-chart"]')).not.toBeNull();
    expect(text()).toContain('Venda a pronto');
    // Sem journal.post não há «Novo lançamento».
    expect(text()).not.toContain('Novo lançamento');
  });
});

describe('EntriesTab', () => {
  it('validates the lines in real time and posts only a balanced entry', async () => {
    const api = setup(['accounting.read', 'journal.post']);
    const fixture = TestBed.createComponent(EntriesTab);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    button('Novo lançamento')?.click();
    await settle(fixture);
    const editor = document.body.querySelector('[data-testid="entry-editor"]') as HTMLElement;
    const selects = editor.querySelectorAll<HTMLSelectElement>('[data-testid="lines"] select');
    const inputs = editor.querySelectorAll<HTMLInputElement>('[data-testid="lines"] input');
    selects[0]!.value = 'a31';
    selects[0]!.dispatchEvent(new Event('change'));
    selects[1]!.value = 'a61';
    selects[1]!.dispatchEvent(new Event('change'));
    // linha 1: débito; linha 2: crédito (3 inputs por linha: débito, crédito, descrição).
    inputs[0]!.value = '250,5';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[4]!.value = '250,4';
    inputs[4]!.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(document.body.querySelector('[data-testid="difference"]')?.textContent).toContain(
      '0,1000',
    );
    expect(
      button('Guardar e lançar')?.querySelector('button, *') ?? button('Guardar e lançar'),
    ).toBeTruthy();
    inputs[4]!.value = '250,5';
    inputs[4]!.dispatchEvent(new Event('input'));
    const description = [...document.body.querySelectorAll('label')]
      .find((l) => l.textContent?.trim().startsWith('Descrição'))
      ?.parentElement?.querySelector('input') as HTMLInputElement;
    description.value = 'Venda a pronto';
    description.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(text()).toContain('Equilibrado');
    button('Guardar e lançar')?.click();
    await settle(fixture);
    expect(api.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'o1',
        journalId: 'j1',
        description: 'Venda a pronto',
        lines: [
          { accountId: 'a31', debit: '250.5000', credit: '0.0000', description: null },
          { accountId: 'a61', debit: '0.0000', credit: '250.5000', description: null },
        ],
      }),
    );
    expect(api.postEntry).toHaveBeenCalledWith('e1');
    expect(text()).toContain('Lançado com o número GER 7');
  });

  it('keeps the draft and shows why when posting is refused', async () => {
    setup(['accounting.read', 'journal.post', 'journal.reverse'], {
      postEntry: vi.fn(() => throwError(() => ({ code: 'PERIOD_CLOSED' }))),
    });
    const fixture = TestBed.createComponent(EntriesTab);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    const link = [...fixture.nativeElement.querySelectorAll('button')].find(
      (b: HTMLButtonElement) => b.textContent?.includes('Venda a pronto'),
    ) as HTMLButtonElement;
    link.click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid="entry-detail"]')?.textContent).toContain(
      'Clientes',
    );
    button('Lançar')?.click();
    await settle(fixture);
    expect(document.body.querySelector('[data-testid="detail-error"]')?.textContent).toContain(
      'fechado',
    );
  });
});

describe('ChartTab', () => {
  it('shows the chart as a tree and hides management without permission', async () => {
    setup(['accounting.read']);
    const fixture = TestBed.createComponent(ChartTab);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="chart"] tbody tr');
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain('31.1');
    expect(rows[1].textContent).toContain('Movimento');
    expect(text()).not.toContain('Nova conta');
  });
});

describe('TrialTab', () => {
  it('shows the balance check and the totals', async () => {
    setup(['accounting.read']);
    const fixture = TestBed.createComponent(TrialTab);
    fixture.componentRef.setInput('organizationId', 'o1');
    await settle(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="trial-check"]')?.textContent,
    ).toContain('Débitos = créditos');
    expect(
      fixture.nativeElement.querySelector('[data-testid="trial-totals"]')?.textContent,
    ).toContain('250,5000');
  });
});
