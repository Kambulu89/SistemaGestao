import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { FinanceApi, type AccountDto } from './finance.api';
import {
  ReconciliationApi,
  type ReconEntryDto,
  type StatementLineDetailDto,
  type StatementLineDto,
  type SuggestionDto,
} from './reconciliation.api';
import {
  parseAmount,
  parseDate,
  parseStatementCsv,
  reconciliationError,
} from './reconciliation-model';
import { ReconciliationTab } from './reconciliation-tab';
import { TreasuryPage } from './treasury-page';

describe('parseAmount', () => {
  it('aceita formatos portugueses e ingleses sem passar por number', () => {
    expect(parseAmount('1.234,56')).toBe('1234.56');
    expect(parseAmount('1,234.56')).toBe('1234.56');
    expect(parseAmount('1234,5')).toBe('1234.5');
    expect(parseAmount('1.234.567')).toBe('1234567');
    expect(parseAmount('-25,50')).toBe('-25.50');
    expect(parseAmount('(10,00)')).toBe('-10.00');
    expect(parseAmount('+7')).toBe('7');
    expect(parseAmount('900719925474099.1234')).toBe('900719925474099.1234');
  });

  it('recusa o que não é um valor com até 4 casas', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('1,23456')).toBeNull();
    expect(parseAmount('12-3')).toBeNull();
  });
});

describe('parseDate', () => {
  it('aceita ISO e dia/mês/ano e recusa datas que não existem', () => {
    expect(parseDate('2026-10-05')).toBe('2026-10-05');
    expect(parseDate('5/10/2026')).toBe('2026-10-05');
    expect(parseDate('05.10.2026')).toBe('2026-10-05');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('ontem')).toBeNull();
  });
});

describe('parseStatementCsv', () => {
  it('lê cabeçalhos com acentos, ponto e vírgula e aspas', () => {
    const result = parseStatementCsv(
      [
        'Data;Descrição;Valor;Referência',
        '10/10/2026;"Transf. Acme; Lda";1.500,00;REC-1',
        '11/10/2026;Comissão;-25,5;',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([
      {
        occurredOn: '2026-10-10',
        amount: '1500.00',
        description: 'Transf. Acme; Lda',
        reference: 'REC-1',
      },
      { occurredOn: '2026-10-11', amount: '-25.5', description: 'Comissão' },
    ]);
  });

  it('aceita colunas de crédito e débito', () => {
    const result = parseStatementCsv(
      ['data,crédito,débito', '2026-10-10,100,', '2026-10-11,,40'].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.lines.map((l) => l.amount)).toEqual(['100', '-40']);
  });

  it('diz que linhas têm problemas e não devolve linhas parciais enganadoras', () => {
    const result = parseStatementCsv(
      ['data;valor', '10/10/2026;abc', '32/10/2026;5', '12/10/2026;0'].join('\n'),
    );
    expect(result.lines).toEqual([]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain('Linha 2');
  });

  it('exige cabeçalhos reconhecíveis e movimentos', () => {
    expect(parseStatementCsv('data;valor').errors).toHaveLength(1);
    expect(parseStatementCsv('foo;bar\n1;2').errors[0]).toContain('data');
    expect(parseStatementCsv('data;foo\n10/10/2026;2').errors[0]).toContain('valor');
  });
});

describe('reconciliationError', () => {
  it('traduz códigos da conciliação e cai nos das finanças', () => {
    expect(reconciliationError({ code: 'DIRECTION_MISMATCH' }, 'x')).toContain('saída');
    expect(reconciliationError({ code: 'ACCOUNT_ORGANIZATION' }, 'x')).toContain(
      'outra organização',
    );
    expect(reconciliationError({}, 'falhou')).toBe('falhou');
  });
});

const BANK = {
  id: 'b1',
  organizationId: 'o1',
  code: 'BAI',
  name: 'Banco',
  type: 'BANK',
  currency: 'AOA',
  bankName: null,
  accountIdentifier: null,
  active: true,
  balance: '100.0000',
  version: 1,
} as AccountDto;
const CASH = { ...BANK, id: 'c1', code: 'CAIXA', name: 'Caixa', type: 'CASH' } as AccountDto;

const LINE: StatementLineDto = {
  id: 'l1',
  accountId: 'b1',
  batchId: 'bt1',
  occurredOn: '2026-10-10',
  amountSigned: '100.0000',
  description: 'Transferência Acme',
  reference: null,
  matched: '0.0000',
  remaining: '100.0000',
  state: 'UNMATCHED',
};
const ENTRY: ReconEntryDto = {
  id: 'e1',
  accountId: 'b1',
  paymentReference: null,
  partyName: 'Acme, Lda.',
  amountSigned: '100.0000',
  occurredOn: '2026-10-10',
  matched: '0.0000',
  remaining: '100.0000',
  state: 'UNMATCHED',
};
const SUGGESTION: SuggestionDto = {
  entryId: 'e1',
  score: 90,
  matchableAmount: '100.0000',
  reasons: ['Valor igual', 'Mesma data'],
  entry: ENTRY,
};
const DETAIL: StatementLineDetailDto = {
  ...LINE,
  matches: [
    {
      id: 'm1',
      statementLineId: 'l1',
      treasuryEntryId: 'e1aaaaaa-1111',
      matchedAmount: '40.0000',
      confirmedAt: '2026-10-10T10:00:00Z',
      undoneAt: null,
      undoReason: null,
    },
  ],
};

const page = <T>(items: T[]) => ({ items, total: items.length });
const ALL = [
  'finance.read',
  'reconciliation.read',
  'reconciliation.manage',
  'reconciliation.confirm',
];

function configure(api: Record<string, unknown> = {}, granted: readonly string[] = ALL) {
  const full = {
    summary: vi.fn(() =>
      of({
        currency: 'AOA',
        bookBalance: '100.0000',
        statementTotal: '60.0000',
        lines: { total: 2, unmatched: 1, partial: 0, matched: 1 },
        entries: { total: 1, unmatched: 1, partial: 0, matched: 0 },
        unmatchedStatementAmount: '-40.0000',
        unmatchedBookAmount: '100.0000',
      }),
    ),
    lines: vi.fn(() => of(page([LINE]))),
    line: vi.fn(() => of(DETAIL)),
    suggestions: vi.fn(() => of([SUGGESTION])),
    entries: vi.fn(() => of(page([ENTRY]))),
    batches: vi.fn(() =>
      of(
        page([
          { id: 'bt1', fileName: 'extracto.csv', lineCount: 2, skippedCount: 1, createdAt: '' },
        ]),
      ),
    ),
    ...api,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1' }) } },
      { provide: ReconciliationApi, useValue: full },
      { provide: FinanceApi, useValue: { accounts: () => of(page([BANK, CASH])) } },
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

const text = () => document.body.textContent ?? '';
const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((b) =>
    b.textContent?.trim().startsWith(label),
  );

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const mocked = configure(api, granted);
  const fixture = TestBed.createComponent(ReconciliationTab);
  await settle(fixture);
  const select = document.body.querySelector('select') as HTMLSelectElement;
  select.value = 'b1';
  select.dispatchEvent(new Event('change'));
  await settle(fixture);
  return { fixture, mocked };
}

describe('ReconciliationTab', () => {
  it('só oferece contas bancárias e mostra o resumo e o extracto da conta escolhida', async () => {
    await open();
    const options = [...document.body.querySelectorAll('select option')].map((o) => o.textContent);
    expect(options.join('|')).toContain('BAI');
    expect(options.join('|')).not.toContain('CAIXA');
    expect(text()).toContain('Transferência Acme');
    expect(text()).toContain('2026-10-10');
    expect(document.body.querySelector('[data-testid=open-statement]')?.textContent).toContain(
      '-40,0000',
    );
    expect(text()).toContain('1 por conciliar');
  });

  it('pede sugestões ao abrir uma linha e confirma com o valor sugerido', async () => {
    const confirm = vi.fn(() => of({ id: 'm9' }));
    const { fixture, mocked } = await open({ confirm });
    buttons('Conciliar')[0]!.click();
    await settle(fixture);
    expect(mocked.suggestions).toHaveBeenCalledWith('l1');
    expect(document.body.querySelector('[data-testid=suggestions]')?.textContent).toContain(
      'Valor igual',
    );
    buttons('Confirmar')[0]!.click();
    await settle(fixture);
    expect(confirm).toHaveBeenCalledWith({
      statementLineId: 'l1',
      treasuryEntryId: 'e1',
      amount: '100.0000',
    });
    expect(text()).toContain('Correspondência confirmada');
  });

  it('mostra o erro do servidor quando a confirmação é recusada', async () => {
    const confirm = vi.fn(() => throwError(() => ({ code: 'LINE_FULLY_MATCHED' })));
    const { fixture } = await open({ confirm });
    buttons('Conciliar')[0]!.click();
    await settle(fixture);
    buttons('Confirmar')[0]!.click();
    await settle(fixture);
    expect(text()).toContain('já está conciliada');
  });

  it('desfazer exige motivo', async () => {
    const undo = vi.fn(() => of({ id: 'm1' }));
    const { fixture } = await open({ undo });
    buttons('Conciliar')[0]!.click();
    await settle(fixture);
    buttons('Desfazer')[0]!.click();
    await settle(fixture);
    buttons('Desfazer').at(-1)!.click();
    await settle(fixture);
    expect(undo).not.toHaveBeenCalled();
    expect(text()).toContain('Indique o motivo');
    const input = document.body.querySelector('dialog input') as HTMLInputElement;
    input.value = 'Par errado';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    buttons('Desfazer').at(-1)!.click();
    await settle(fixture);
    expect(undo).toHaveBeenCalledWith('m1', 'Par errado');
  });

  it('importa o CSV colado e mostra quantas linhas entraram', async () => {
    const importStatement = vi.fn(() => of({ batch: { id: 'bt2' }, imported: 2, skipped: 1 }));
    const { fixture } = await open({ importStatement });
    const area = document.body.querySelector('[data-testid=statement-text]') as HTMLTextAreaElement;
    area.value = 'data;valor;descrição\n10/10/2026;100;Recebimento\n11/10/2026;-3,5;Comissão';
    area.dispatchEvent(new Event('input'));
    await settle(fixture);
    buttons('Importar 2 linhas')[0]!.click();
    await settle(fixture);
    expect(importStatement).toHaveBeenCalledWith({
      accountId: 'b1',
      lines: [
        { occurredOn: '2026-10-10', amount: '100', description: 'Recebimento' },
        { occurredOn: '2026-10-11', amount: '-3.5', description: 'Comissão' },
      ],
    });
    expect(text()).toContain('2 linhas importadas, 1 ignoradas');
  });

  it('um ficheiro com erros não se importa', async () => {
    const importStatement = vi.fn();
    const { fixture } = await open({ importStatement });
    const area = document.body.querySelector('[data-testid=statement-text]') as HTMLTextAreaElement;
    area.value = 'data;valor\n10/10/2026;abc';
    area.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(document.body.querySelector('[data-testid=csv-errors]')?.textContent).toContain(
      'Linha 2',
    );
    expect(buttons('Importar')[0]!.disabled).toBe(true);
    expect(importStatement).not.toHaveBeenCalled();
  });

  it('sem reconciliation.manage e .confirm não há importar, descartar, confirmar nem desfazer', async () => {
    const { fixture } = await open({}, ['finance.read', 'reconciliation.read']);
    expect(document.body.querySelector('[data-testid=statement-text]')).toBeNull();
    expect(buttons('Descartar')).toHaveLength(0);
    buttons('Conciliar')[0]!.click();
    await settle(fixture);
    expect(buttons('Confirmar')).toHaveLength(0);
    expect(buttons('Desfazer')).toHaveLength(0);
  });
});

describe('TreasuryPage com conciliação', () => {
  it('o separador depende de reconciliation.read', async () => {
    configure({}, ['finance.read', 'treasury.read']);
    // O resto da página usa a sua API; aqui só interessa a lista de separadores.
    TestBed.overrideProvider(FinanceApi, {
      useValue: { accounts: () => of(page([BANK])), entries: () => of(page([])) },
    });
    const without = TestBed.createComponent(TreasuryPage);
    await settle(without);
    expect(
      [...document.body.querySelectorAll('[role=tab]')].map((t) => t.textContent?.trim()),
    ).toEqual(['Contas']);
  });
});
