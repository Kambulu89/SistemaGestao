import { type Account, accountTree, entryActions, fromScaled, lineTotals, toScaled } from './model';

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
