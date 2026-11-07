import {
  type Account,
  type ScheduleLine,
  accountTree,
  assetActions,
  currentMonth,
  entryActions,
  fromScaled,
  lifeText,
  lineTotals,
  toScaled,
} from './model';

describe('contabilidade: modelo', () => {
  it('decimais sem float', () => {
    expect(toScaled('0.1', 2)).toBe(10n);
    expect(toScaled('1.234', 2)).toBeNull();
    expect(toScaled('-1', 2)).toBeNull();
    expect(fromScaled(30n, 2)).toBe('0.30');
    expect(fromScaled(-5n, 2)).toBe('-0.05');
  });

  it('totais e equilíbrio enquanto se escreve', () => {
    expect(
      lineTotals(
        [
          { debit: '0.1', credit: '' },
          { debit: '0.2', credit: '' },
          { debit: '', credit: '0.3' },
        ],
        2,
      ),
    ).toEqual({
      debit: '0.30',
      credit: '0.30',
      difference: '0.00',
      balanced: true,
      invalid: false,
    });
    const t = lineTotals(
      [
        { debit: '10', credit: '' },
        { debit: '', credit: 'abc' },
      ],
      2,
    );
    expect(t.invalid).toBe(true);
    expect(t.balanced).toBe(false);
    expect(
      lineTotals(
        [
          { debit: '10', credit: '' },
          { debit: '', credit: '4' },
        ],
        2,
      ).difference,
    ).toBe('6.00');
  });

  it('árvore de contas: pai antes dos filhos, por código', () => {
    const a = (id: string, code: string, parentId: string | null) =>
      ({ id, code, parentId }) as Account;
    const tree = accountTree([
      a('3', '111', '2'),
      a('1', '1', null),
      a('2', '11', '1'),
      a('4', '2', null),
    ]);
    expect(tree.map((t) => [t.account.code, t.depth])).toEqual([
      ['1', 0],
      ['11', 1],
      ['111', 2],
      ['2', 0],
    ]);
  });

  it('acções: segregação de funções e estados', () => {
    const all = { userId: 'u1', can: () => true };
    const mine = {
      status: 'SUBMITTED' as const,
      createdBy: 'u1',
      submittedBy: 'u1',
      reversalOfId: null,
      reversedById: null,
    };
    expect(entryActions(mine, all).approve).toBe(false);
    expect(entryActions(mine, { ...all, userId: 'u2' }).approve).toBe(true);
    const posted = { ...mine, status: 'POSTED' as const };
    expect(entryActions(posted, all)).toMatchObject({ edit: false, reverse: true, post: false });
    expect(entryActions({ ...posted, reversedById: 'x' }, all).reverse).toBe(false);
    expect(
      entryActions(
        { ...mine, status: 'DRAFT' },
        { userId: 'u1', can: (p) => p === 'accounting.read' },
      ).edit,
    ).toBe(false);
  });
});

describe('contabilidade: valores escritos', () => {
  it('aceita vírgula decimal e separadores de milhares', async () => {
    const { normalizeAmount, lineTotals } = await import('./model');
    expect(normalizeAmount(' 1 500,25 ')).toBe('1500.25');
    expect(normalizeAmount('1.500,25')).toBe('1500.25');
    expect(normalizeAmount('1500.25')).toBe('1500.25');
    expect(
      lineTotals(
        [
          { debit: '1500,25', credit: '' },
          { debit: '', credit: '1 500,25' },
        ],
        2,
      ).balanced,
    ).toBe(true);
  });
});

describe('contabilidade: motor', () => {
  it('chaves de montante únicas e mensagem de erro do evento', async () => {
    const { amountKeys, eventErrorText } = await import('./model');
    expect(
      amountKeys([
        { amountKey: 'total' },
        { amountKey: 'net' },
        { amountKey: ' total ' },
        { amountKey: '' },
      ]),
    ).toEqual(['total', 'net']);
    const failed = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Verifique os campos indicados.',
        details: [{ path: 'event', code: 'NO_RULE', message: 'Não há regra activa.' }],
      },
    } as never;
    expect(eventErrorText(failed)).toBe('Verifique os campos indicados. Não há regra activa.');
    expect(eventErrorText({ error: null } as never)).toBe('');
  });
});

describe('contabilidade: abertura e relatórios', () => {
  it('lê CSV com ; e cabeçalho, vírgula decimal e linhas vazias', async () => {
    const { parseOpeningCsv } = await import('./model');
    const lines = parseOpeningCsv(
      'Conta;Débito;Crédito;Centro\n111;1 000,50;;CC1\n\n21;;1000,50;\n',
    );
    expect(lines).toEqual([
      {
        accountCode: '111',
        debit: '1000.50',
        credit: null,
        costCenterCode: 'CC1',
        thirdPartyRef: null,
        description: null,
      },
      {
        accountCode: '21',
        debit: null,
        credit: '1000.50',
        costCenterCode: null,
        thirdPartyRef: null,
        description: null,
      },
    ]);
  });

  it('sem cabeçalho usa a ordem conta, débito, crédito; separador tab', async () => {
    const { parseOpeningCsv } = await import('./model');
    expect(parseOpeningCsv('111\t10\t\n21\t\t10')).toMatchObject([
      { accountCode: '111', debit: '10', credit: null },
      { accountCode: '21', debit: null, credit: '10' },
    ]);
  });

  it('saldo com sinal dividido em devedor/credor', async () => {
    const { splitBalance } = await import('./model');
    expect(splitBalance('-150.00')).toEqual({ debit: '', credit: '150.00' });
    expect(splitBalance('20.00')).toEqual({ debit: '20.00', credit: '' });
    expect(splitBalance('0.00')).toEqual({ debit: '', credit: '' });
  });
});

describe('contabilidade: analítica', () => {
  it('soma de percentagens exacta e repartição igual que soma 100', async () => {
    const { percentTotal, evenPercents } = await import('./model');
    expect(
      percentTotal([{ percent: '33,3333' }, { percent: '33.3333' }, { percent: '33.3334' }]),
    ).toEqual({ total: '100', complete: true, invalid: false });
    expect(percentTotal([{ percent: '50' }, { percent: '40' }]).complete).toBe(false);
    expect(percentTotal([{ percent: '-1' }, { percent: '101' }]).invalid).toBe(true);
    expect(evenPercents(3)).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(evenPercents(4)).toEqual(['25', '25', '25', '25']);
    expect(percentTotal(evenPercents(7).map((percent) => ({ percent }))).complete).toBe(true);
  });
});

describe('contabilidade: activos fixos', () => {
  const can = (allowed: string[]) => (p: string) => allowed.includes(p);
  const all = can(['fixed_assets.manage', 'fixed_assets.post']);

  it('acções por estado e permissão', () => {
    expect(assetActions({ status: 'DRAFT', schedule: [] }, all)).toEqual({
      edit: true,
      remove: true,
      acquire: true,
      transfer: false,
      dispose: false,
      reverseAcquisition: false,
      reverseDisposal: false,
    });
    const posted = [{ posted: true } as ScheduleLine];
    const active = assetActions({ status: 'ACTIVE', schedule: posted }, all);
    expect(active.transfer && active.dispose).toBe(true);
    expect(active.reverseAcquisition).toBe(false);
    expect(assetActions({ status: 'ACTIVE', schedule: [] }, all).reverseAcquisition).toBe(true);
    expect(assetActions({ status: 'DISPOSED', schedule: posted }, all).reverseDisposal).toBe(true);
    const reader = assetActions({ status: 'ACTIVE', schedule: [] }, can([]));
    expect(Object.values(reader).some(Boolean)).toBe(false);
    expect(assetActions({ status: 'DRAFT' }, can(['fixed_assets.manage'])).acquire).toBe(false);
  });

  it('textos de vida útil e mês corrente', () => {
    expect(lifeText(60)).toBe('5 anos');
    expect(lifeText(18)).toBe('1 ano e 6 meses');
    expect(lifeText(1)).toBe('1 mês');
    expect(currentMonth(new Date(2026, 0, 31))).toBe('2026-01');
  });
});

describe('contabilidade: regularizações', () => {
  it('totais da reconciliação: só com 2+ linhas do mesmo terceiro a anularem-se', async () => {
    const { selectionTotals, itemKey } = await import('./model');
    const item = (lineNo: number, debit: string, credit: string, thirdPartyRef = 'F1') => ({
      entryId: `e${lineNo}`,
      lineNo,
      date: '2026-03-01',
      number: null,
      description: '',
      thirdPartyRef,
      debit,
      credit,
    });
    const items = [
      item(1, '0.00', '500.00'),
      item(2, '300.00', '0.00'),
      item(3, '200.00', '0.00'),
      item(4, '500.00', '0.00', 'F2'),
    ];
    const pick = (...n: number[]) => new Set(n.map((i) => itemKey(items[i - 1])));
    expect(selectionTotals(items, pick(1, 2), 2)).toMatchObject({
      difference: '-200.00',
      ready: false,
    });
    expect(selectionTotals(items, pick(1, 2, 3), 2)).toMatchObject({
      debit: '500.00',
      credit: '500.00',
      ready: true,
    });
    expect(selectionTotals(items, pick(1, 4), 2)).toMatchObject({
      sameThirdParty: false,
      ready: false,
    });
    expect(selectionTotals(items, pick(1), 2).ready).toBe(false);
  });
});

describe('contabilidade: mudança de entidade', () => {
  it('limpa as escolhas que não existem nas listas da nova entidade', async () => {
    const { keepKnown } = await import('./shared');
    const form = { journalId: 'j-old', debitAccountId: 'a1', creditAccountId: 'a-old', name: 'x' };
    keepKnown(form, ['journalId'], [{ id: 'j-new' }]);
    keepKnown(form, ['debitAccountId', 'creditAccountId'], [{ id: 'a1' }]);
    expect(form).toEqual({
      journalId: null,
      debitAccountId: 'a1',
      creditAccountId: null,
      name: 'x',
    });
  });
});

describe('contabilidade: demonstrações', () => {
  it('prefixos das linhas: texto ↔ regras de saldo', async () => {
    const { formatMappings, parseMappings } = await import('./model');
    expect(parseMappings('111, 113:D; 113:c')).toEqual([
      { prefix: '111', rule: 'ANY' },
      { prefix: '113', rule: 'DEBIT' },
      { prefix: '113', rule: 'CREDIT' },
    ]);
    expect(parseMappings('')).toEqual([]);
    expect(parseMappings('11:X')).toBeNull();
    expect(
      formatMappings([
        { prefix: '22', rule: 'ANY' },
        { prefix: '113', rule: 'CREDIT' },
      ]),
    ).toBe('22, 113:C');
  });
});
