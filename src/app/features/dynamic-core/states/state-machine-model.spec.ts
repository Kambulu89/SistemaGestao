import {
  addState,
  addTransition,
  nextCode,
  reachable,
  removeState,
  removeTransition,
  setInitial,
  slug,
  toggleFrom,
  updateState,
  updateTransition,
  type Machine,
} from './state-machine-model';

const machine = (): Machine => ({
  states: [
    { code: 'aberto', label: 'Aberto', category: 'INITIAL', editable: true },
    { code: 'em_curso', label: 'Em curso', category: 'ACTIVE', editable: true },
    { code: 'feito', label: 'Feito', category: 'FINAL', editable: false },
  ],
  transitions: [
    { code: 'iniciar', label: 'Iniciar', from: ['aberto'], to: 'em_curso', reasonRequired: false },
    {
      code: 'fechar',
      label: 'Fechar',
      from: ['aberto', 'em_curso'],
      to: 'feito',
      reasonRequired: true,
    },
  ],
});

describe('códigos', () => {
  it('nextCode não repete e slug tira acentos e símbolos', () => {
    expect(nextCode('estado', [])).toBe('estado');
    expect(nextCode('estado', ['estado', 'estado_2'])).toBe('estado_3');
    expect(slug('Em Análise — 1ª fase')).toBe('em_analise_1a_fase');
    expect(slug('1 abc')).toBe('');
    expect(slug('  ')).toBe('');
  });
});

describe('estados', () => {
  it('o primeiro estado é o inicial; os seguintes são activos', () => {
    const first = addState({ states: [], transitions: [] });
    expect(first.states[0]).toMatchObject({ code: 'estado', category: 'INITIAL' });
    const second = addState(first);
    expect(second.states[1]).toMatchObject({ code: 'estado_2', category: 'ACTIVE' });
  });

  it('mudar o código acompanha as transições; os outros campos não mexem nelas', () => {
    const renamed = updateState(machine(), 1, { code: 'a_fazer' });
    expect(renamed.transitions[0]!.to).toBe('a_fazer');
    expect(renamed.transitions[1]!.from).toEqual(['aberto', 'a_fazer']);
    const relabelled = updateState(machine(), 1, { label: 'Outro' });
    expect(relabelled.transitions).toEqual(machine().transitions);
    expect(updateState(machine(), 1, { color: 'brand' }).states[1]!.color).toBe('brand');
    expect(
      updateState(updateState(machine(), 1, { color: 'brand' }), 1, { color: undefined }).states[1],
    ).not.toHaveProperty('color');
  });

  it('setInitial deixa um só estado inicial', () => {
    const m = setInitial(machine(), 1);
    expect(m.states.map((s) => s.category)).toEqual(['ACTIVE', 'INITIAL', 'FINAL']);
  });

  it('remover um estado remove as transições que nele terminam e tira-o das origens', () => {
    const { machine: m, affected } = removeState(machine(), 1);
    expect(affected).toBe(2);
    expect(m.states.map((s) => s.code)).toEqual(['aberto', 'feito']);
    expect(m.transitions.map((t) => [t.code, t.from])).toEqual([['fechar', ['aberto']]]);
    // Sem o estado inicial «aberto»: «iniciar» (só dele) desaparece e «fechar» fica só com «em_curso».
    const gone = removeState(machine(), 0);
    expect(gone.machine.transitions.map((t) => [t.code, t.from])).toEqual([
      ['fechar', ['em_curso']],
    ]);
  });
});

describe('transições', () => {
  it('nova transição liga os dois primeiros estados; altera, alterna origens e remove', () => {
    const added = addTransition(machine());
    expect(added.transitions[2]).toMatchObject({
      code: 'transicao',
      from: ['aberto'],
      to: 'em_curso',
      reasonRequired: false,
    });
    const patched = updateTransition(added, 2, {
      label: 'X',
      guard: { op: 'true' },
      permission: 'audit.read',
    });
    expect(patched.transitions[2]).toMatchObject({ label: 'X', permission: 'audit.read' });
    const cleared = updateTransition(patched, 2, { guard: undefined });
    expect(cleared.transitions[2]).not.toHaveProperty('guard');
    const widened = toggleFrom(machine(), 0, 'em_curso', true);
    expect(widened.transitions[0]!.from).toEqual(['aberto', 'em_curso']);
    expect(toggleFrom(widened, 0, 'aberto', false).transitions[0]!.from).toEqual(['em_curso']);
    expect(removeTransition(machine(), 0).transitions.map((t) => t.code)).toEqual(['fechar']);
  });

  it('alcançabilidade a partir do estado inicial', () => {
    expect(reachable(machine())).toEqual(new Set(['aberto', 'em_curso', 'feito']));
    const lonely = {
      ...machine(),
      states: [
        ...machine().states,
        { code: 'perdido', label: 'P', category: 'ACTIVE' as const, editable: true },
      ],
    };
    expect(reachable(lonely).has('perdido')).toBe(false);
    expect(reachable({ states: [], transitions: [] }).size).toBe(0);
  });
});
