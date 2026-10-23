/**
 * Máquinas de estados (C13): as acções legais de cada registo e o fim das alterações directas de estado. Estados e
 * transições são dados declarativos validados pelo servidor; a guarda de uma transição é uma condição (AST), nunca código.
 * Chamar «validado» a um estado não faz nada além de mudar o estado: efeitos de negócio (faturar, movimentar stock…) são
 * comandos próprios de cada módulo, nunca uma consequência de um nome de estado.
 */
export type MachineStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED'
export const STATE_CATEGORIES = ['INITIAL', 'ACTIVE', 'FINAL', 'CANCELLED'] as const
export type StateCategory = (typeof STATE_CATEGORIES)[number]

export interface StateDef {
  code: string
  label: string
  category: StateCategory
  /** `false`: o registo não aceita alterações de valores enquanto estiver neste estado. */
  editable: boolean
  color?: string
}

export interface TransitionDef {
  code: string
  label: string
  /** Estados de origem. */
  from: string[]
  to: string
  /** Permissão adicional do catálogo (além de `dynamic.transition`). */
  permission?: string
  /** Condição (AST das políticas de acesso) avaliada sobre os dados actuais do registo. */
  guard?: unknown
  reasonRequired: boolean
}

export interface MachineIssue {
  path: string
  code: string
  message: string
}

export const MACHINE_CODE = /^[a-z][a-z0-9_]{1,49}$/
export const STATE_CODE = /^[a-z][a-z0-9_]{1,49}$/
const COLOR = /^[a-z][a-z0-9-]{0,19}$/
export const MAX_STATES = 50
export const MAX_TRANSITIONS = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(
  raw: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: MachineIssue[]
) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({ path: `${path}.${key}`, code: 'UNKNOWN_KEY', message: `«${key}» não existe.` })
    }
  }
}

export function normalizeStates(raw: unknown, issues: MachineIssue[]): StateDef[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STATES) {
    issues.push({
      path: 'states',
      code: 'INVALID_STATES',
      message: `Indique 1 a ${MAX_STATES} estados.`,
    })
    return []
  }
  const states: StateDef[] = []
  const seen = new Set<string>()
  raw.forEach((item, i) => {
    const path = `states[${i}]`
    if (!isRecord(item)) {
      issues.push({ path, code: 'INVALID_STATE', message: 'Estado inválido.' })
      return
    }
    const before = issues.length
    unknownKeys(item, ['code', 'label', 'category', 'editable', 'color'], path, issues)
    if (typeof item.code !== 'string' || !STATE_CODE.test(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    } else if (seen.has(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'DUPLICATE_STATE',
        message: 'Código de estado repetido.',
      })
    } else seen.add(item.code)
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120) {
      issues.push({
        path: `${path}.label`,
        code: 'INVALID_LABEL',
        message: 'O rótulo é obrigatório (máx. 120).',
      })
    }
    if (!(STATE_CATEGORIES as readonly unknown[]).includes(item.category)) {
      issues.push({
        path: `${path}.category`,
        code: 'INVALID_CATEGORY',
        message: `Categoria: ${STATE_CATEGORIES.join(', ')}.`,
      })
    }
    if (item.editable !== undefined && typeof item.editable !== 'boolean') {
      issues.push({
        path: `${path}.editable`,
        code: 'INVALID_FLAG',
        message: 'editable é booleano.',
      })
    }
    if (item.color !== undefined && (typeof item.color !== 'string' || !COLOR.test(item.color))) {
      issues.push({
        path: `${path}.color`,
        code: 'INVALID_COLOR',
        message: 'Cor: a-z, 0-9 e - (até 20).',
      })
    }
    if (issues.length > before) return
    const category = item.category as StateCategory
    states.push({
      code: item.code as string,
      label: (item.label as string).trim(),
      category,
      // Um estado final ou cancelado fecha o registo por omissão.
      editable:
        typeof item.editable === 'boolean'
          ? item.editable
          : category === 'INITIAL' || category === 'ACTIVE',
      ...(typeof item.color === 'string' ? { color: item.color } : {}),
    })
  })
  return states
}

export function normalizeTransitions(raw: unknown, issues: MachineIssue[]): TransitionDef[] {
  if (!Array.isArray(raw) || raw.length > MAX_TRANSITIONS) {
    issues.push({
      path: 'transitions',
      code: 'INVALID_TRANSITIONS',
      message: `Indique até ${MAX_TRANSITIONS} transições.`,
    })
    return []
  }
  const transitions: TransitionDef[] = []
  const seen = new Set<string>()
  raw.forEach((item, i) => {
    const path = `transitions[${i}]`
    if (!isRecord(item)) {
      issues.push({ path, code: 'INVALID_TRANSITION', message: 'Transição inválida.' })
      return
    }
    const before = issues.length
    unknownKeys(
      item,
      ['code', 'label', 'from', 'to', 'permission', 'guard', 'reasonRequired'],
      path,
      issues
    )
    if (typeof item.code !== 'string' || !STATE_CODE.test(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    } else if (seen.has(item.code)) {
      issues.push({
        path: `${path}.code`,
        code: 'DUPLICATE_TRANSITION',
        message: 'Código de transição repetido.',
      })
    } else seen.add(item.code)
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120) {
      issues.push({
        path: `${path}.label`,
        code: 'INVALID_LABEL',
        message: 'O rótulo é obrigatório (máx. 120).',
      })
    }
    const from = item.from
    if (
      !Array.isArray(from) ||
      from.length === 0 ||
      !from.every((c) => typeof c === 'string' && STATE_CODE.test(c)) ||
      new Set(from).size !== from.length
    ) {
      issues.push({
        path: `${path}.from`,
        code: 'INVALID_FROM',
        message: 'Indique os estados de origem, sem repetir.',
      })
    }
    if (typeof item.to !== 'string' || !STATE_CODE.test(item.to)) {
      issues.push({
        path: `${path}.to`,
        code: 'INVALID_TO',
        message: 'Indique o estado de destino.',
      })
    }
    if (
      item.permission !== undefined &&
      (typeof item.permission !== 'string' || item.permission.length > 80)
    ) {
      issues.push({
        path: `${path}.permission`,
        code: 'INVALID_PERMISSION',
        message: 'Código de permissão inválido.',
      })
    }
    if (item.reasonRequired !== undefined && typeof item.reasonRequired !== 'boolean') {
      issues.push({
        path: `${path}.reasonRequired`,
        code: 'INVALID_FLAG',
        message: 'reasonRequired é booleano.',
      })
    }
    if (item.guard !== undefined && !isRecord(item.guard)) {
      issues.push({
        path: `${path}.guard`,
        code: 'INVALID_GUARD',
        message: 'A guarda é uma condição (objecto).',
      })
    }
    if (issues.length > before) return
    transitions.push({
      code: item.code as string,
      label: (item.label as string).trim(),
      from: item.from as string[],
      to: item.to as string,
      ...(typeof item.permission === 'string' ? { permission: item.permission } : {}),
      ...(item.guard !== undefined ? { guard: item.guard } : {}),
      reasonRequired: item.reasonRequired === true,
    })
  })
  return transitions
}

/** O estado inicial: o único com categoria INITIAL. */
export const initialStateOf = (states: readonly StateDef[]): StateDef | undefined =>
  states.find((s) => s.category === 'INITIAL')

/**
 * Integridade da máquina: um só estado inicial, transições entre estados que existem, nenhuma saída de um estado final ou
 * cancelado, e todos os estados alcançáveis a partir do inicial (um estado inalcançável é um erro de desenho).
 */
export function checkMachine(
  states: readonly StateDef[],
  transitions: readonly TransitionDef[]
): MachineIssue[] {
  const issues: MachineIssue[] = []
  const byCode = new Map(states.map((s) => [s.code, s]))
  const initials = states.filter((s) => s.category === 'INITIAL')
  if (initials.length !== 1) {
    issues.push({
      path: 'states',
      code: 'INITIAL_STATE',
      message: `Tem de haver exactamente um estado inicial (há ${initials.length}).`,
    })
  }
  transitions.forEach((t, i) => {
    const path = `transitions[${i}]`
    for (const code of t.from) {
      const source = byCode.get(code)
      if (!source) {
        issues.push({
          path: `${path}.from`,
          code: 'UNKNOWN_STATE',
          message: `O estado «${code}» não existe.`,
        })
      } else if (source.category === 'FINAL' || source.category === 'CANCELLED') {
        issues.push({
          path: `${path}.from`,
          code: 'TRANSITION_FROM_FINAL',
          message: `«${code}» é um estado final: não tem transições de saída.`,
        })
      }
    }
    const target = byCode.get(t.to)
    if (!target) {
      issues.push({
        path: `${path}.to`,
        code: 'UNKNOWN_STATE',
        message: `O estado «${t.to}» não existe.`,
      })
    } else if (target.category === 'INITIAL') {
      issues.push({
        path: `${path}.to`,
        code: 'TRANSITION_TO_INITIAL',
        message: 'Não se volta ao estado inicial.',
      })
    }
  })
  const [initial] = initials
  if (initial && issues.length === 0) {
    const reached = new Set<string>([initial.code])
    const queue = [initial.code]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const t of transitions) {
        if (t.from.includes(current) && !reached.has(t.to)) {
          reached.add(t.to)
          queue.push(t.to)
        }
      }
    }
    states.forEach((s, i) => {
      if (!reached.has(s.code)) {
        issues.push({
          path: `states[${i}]`,
          code: 'UNREACHABLE_STATE',
          message: `O estado «${s.code}» não é alcançável a partir do estado inicial.`,
        })
      }
    })
  }
  return issues
}

/** Variáveis (`resource.x`, `subject.y`) usadas por uma condição. */
export function conditionVariables(condition: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (isRecord(node)) {
      if (typeof node.var === 'string') found.push(node.var)
      for (const child of Object.values(node)) walk(child)
    }
  }
  walk(condition)
  return [...new Set(found)]
}

export const SUBJECT_VARIABLES = [
  'subject.membershipId',
  'subject.userId',
  'subject.organizationId',
]
export const ENV_VARIABLES = ['env.now']

/** Transições possíveis a partir de um estado (antes de permissões e guardas). */
export const transitionsFrom = (
  transitions: readonly TransitionDef[],
  state: string
): TransitionDef[] => transitions.filter((t) => t.from.includes(state))
