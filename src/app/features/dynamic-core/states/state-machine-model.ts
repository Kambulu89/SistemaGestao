import type { StateCategory, StateDto, TransitionDto } from './states.api';

/**
 * Operações puras sobre os estados e as transições de uma máquina em edição (o estado do designer é o próprio modelo do
 * servidor, imutável): cada operação devolve novas listas. As transições referem os estados por código.
 */
export interface Machine {
  readonly states: readonly StateDto[];
  readonly transitions: readonly TransitionDto[];
}

/** Próximo código livre a partir de uma base: `estado`, `estado_2`, … */
export function nextCode(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** Código técnico sugerido para um rótulo: minúsculas, sem acentos, `a-z0-9_`, a começar por letra. */
export function slug(label: string): string {
  const text = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(text) ? text.slice(0, 50) : '';
}

export function addState(machine: Machine): Machine {
  const hasInitial = machine.states.some((s) => s.category === 'INITIAL');
  const code = nextCode(
    'estado',
    machine.states.map((s) => s.code),
  );
  const state: StateDto = {
    code,
    label: hasInitial ? 'Novo estado' : 'Inicial',
    category: hasInitial ? 'ACTIVE' : 'INITIAL',
    editable: true,
  };
  return { ...machine, states: [...machine.states, state] };
}

export function updateState(machine: Machine, index: number, patch: Partial<StateDto>): Machine {
  const current = machine.states[index];
  if (!current) return machine;
  const next = { ...current, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  // Mudar o código acompanha as transições que o referem.
  const renamed = patch.code !== undefined && patch.code !== current.code;
  const states = machine.states.map((s, i) => (i === index ? (next as unknown as StateDto) : s));
  const transitions = renamed
    ? machine.transitions.map((t) => ({
        ...t,
        from: t.from.map((c) => (c === current.code ? (patch.code as string) : c)),
        to: t.to === current.code ? (patch.code as string) : t.to,
      }))
    : machine.transitions;
  return { states, transitions };
}

/** Torna um estado o inicial: o anterior passa a activo (há exactamente um estado inicial). */
export function setInitial(machine: Machine, index: number): Machine {
  return {
    ...machine,
    states: machine.states.map((s, i) =>
      i === index
        ? { ...s, category: 'INITIAL', editable: true }
        : s.category === 'INITIAL'
          ? { ...s, category: 'ACTIVE' as StateCategory }
          : s,
    ),
  };
}

/**
 * Remove um estado e as transições que dependem dele (as que nele terminam desaparecem; nas que dele partem, a origem sai
 * e a transição desaparece se ficar sem origens). Devolve também quantas transições foram afectadas.
 */
export function removeState(
  machine: Machine,
  index: number,
): { machine: Machine; affected: number } {
  const removed = machine.states[index];
  if (!removed) return { machine, affected: 0 };
  let affected = 0;
  const transitions: TransitionDto[] = [];
  for (const t of machine.transitions) {
    if (t.to === removed.code) {
      affected += 1;
      continue;
    }
    if (t.from.includes(removed.code)) {
      affected += 1;
      const from = t.from.filter((c) => c !== removed.code);
      if (from.length > 0) transitions.push({ ...t, from });
      continue;
    }
    transitions.push(t);
  }
  return {
    machine: { states: machine.states.filter((_, i) => i !== index), transitions },
    affected,
  };
}

export function addTransition(machine: Machine): Machine {
  const [first, second] = machine.states;
  const transition: TransitionDto = {
    code: nextCode(
      'transicao',
      machine.transitions.map((t) => t.code),
    ),
    label: 'Nova transição',
    from: first ? [first.code] : [],
    to: (second ?? first)?.code ?? '',
    reasonRequired: false,
  };
  return { ...machine, transitions: [...machine.transitions, transition] };
}

export function updateTransition(
  machine: Machine,
  index: number,
  patch: Partial<TransitionDto>,
): Machine {
  const current = machine.transitions[index];
  if (!current) return machine;
  const next = { ...current, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return {
    ...machine,
    transitions: machine.transitions.map((t, i) =>
      i === index ? (next as unknown as TransitionDto) : t,
    ),
  };
}

export function toggleFrom(machine: Machine, index: number, state: string, on: boolean): Machine {
  const current = machine.transitions[index];
  if (!current) return machine;
  const from = machine.states
    .map((s) => s.code)
    .filter((code) => (code === state ? on : current.from.includes(code)));
  return updateTransition(machine, index, { from });
}

export function removeTransition(machine: Machine, index: number): Machine {
  return { ...machine, transitions: machine.transitions.filter((_, i) => i !== index) };
}

/** Estados alcançáveis a partir do inicial (o mesmo critério do servidor), para o «mapa» do designer. */
export function reachable(machine: Machine): Set<string> {
  const initial = machine.states.find((s) => s.category === 'INITIAL');
  const reached = new Set<string>();
  if (!initial) return reached;
  reached.add(initial.code);
  const queue = [initial.code];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const t of machine.transitions) {
      if (t.from.includes(current) && !reached.has(t.to)) {
        reached.add(t.to);
        queue.push(t.to);
      }
    }
  }
  return reached;
}
