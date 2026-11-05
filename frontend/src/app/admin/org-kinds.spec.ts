import { flattenTree, ORG_KINDS, payloadFor, sectionOf } from './org-kinds';

describe('payloadFor', () => {
  const positions = ORG_KINDS['positions'];

  it('na criação envia só os campos preenchidos, aparados e com números', () => {
    const body = payloadFor(
      positions,
      { code: ' P1 ', name: 'Analista', level: '3', jobFamily: '', status: 'ACTIVE' },
      null,
    );
    expect(body).toEqual({ code: 'P1', name: 'Analista', level: 3, status: 'ACTIVE' });
  });

  it('na alteração envia só o que mudou e nunca os imutáveis', () => {
    const original = {
      id: 'x',
      version: 2,
      code: 'P1',
      name: 'Analista',
      level: 3,
      jobFamily: null,
      status: 'ACTIVE',
    };
    const body = payloadFor(
      positions,
      { ...original, code: 'OUTRO', name: 'Analista sénior', jobFamily: '' },
      original,
    );
    expect(body).toEqual({ name: 'Analista sénior' });
  });

  it('limpar um campo opcional envia null', () => {
    const original = {
      id: 'x',
      version: 1,
      code: 'P1',
      name: 'A',
      jobFamily: 'TI',
      status: 'ACTIVE',
    };
    expect(payloadFor(positions, { ...original, jobFamily: '  ' }, original)).toEqual({
      jobFamily: null,
    });
  });
});

describe('Prompt 05: campos e organograma', () => {
  it('as novas secções: fiscal, contactos, morada e responsáveis', () => {
    const le = ORG_KINDS['legal-entities'];
    const by = (k: string) => le.fields.find((f) => f.key === k)!;
    expect(sectionOf(by('vatRegistered'))).toBe('fiscal');
    expect(sectionOf(by('email'))).toBe('contacts');
    expect(sectionOf(by('province'))).toBe('address');
    expect(sectionOf(by('representativeName'))).toBe('links');
    const branch = ORG_KINDS['branches'].fields.find((f) => f.key === 'managerMembershipId')!;
    expect(branch.type).toBe('member');
    expect(sectionOf(branch)).toBe('links');
    expect(ORG_KINDS['positions'].fields.map((f) => f.key)).toEqual(
      expect.arrayContaining(['jobFunction', 'requirements', 'responsibilities']),
    );
  });

  it('booleanos e listas: envia só quando mudam', () => {
    const le = ORG_KINDS['legal-entities'];
    const original = { id: 'x', version: 1, vatRegistered: false, fiscalYearStartMonth: 1 };
    expect(payloadFor(le, { ...original, vatRegistered: true }, original)).toEqual({
      vatRegistered: true,
    });
    const days = { fields: [{ key: 'weekendDays', label: 'D', type: 'weekdays' as const }] };
    const cal = { id: 'c', version: 1, weekendDays: [6, 7] };
    expect(payloadFor(days, { ...cal, weekendDays: [6, 7] }, cal)).toEqual({});
    expect(payloadFor(days, { ...cal, weekendDays: [7] }, cal)).toEqual({ weekendDays: [7] });
  });

  it('flattenTree ordena pais antes dos filhos e põe órfãos na raiz', () => {
    const node = (id: string, code: string, parentId: string | null) => ({
      id,
      code,
      name: code,
      parentId,
      legalEntityId: 'le',
      status: 'ACTIVE',
      managerName: null,
    });
    const items = flattenTree([
      node('c', 'B1', 'b'),
      node('b', 'B', null),
      node('a', 'A', null),
      node('o', 'O', 'fora-do-filtro'),
    ]);
    expect(items.map((i) => [i.node.code, i.depth])).toEqual([
      ['A', 0],
      ['B', 0],
      ['B1', 1],
      ['O', 0],
    ]);
  });
});
