/** Widgets do painel (ids estáveis, guardados nas preferências do membro). */
export const WIDGETS = [
  { id: 'kpis', title: 'Indicadores', wide: true },
  { id: 'approvals-chart', title: 'Pedidos de aprovação', wide: true },
  { id: 'usage', title: 'Utilização do plano', wide: false },
  { id: 'tasks', title: 'As minhas tarefas', wide: false },
  { id: 'activity', title: 'Actividade recente', wide: false },
  { id: 'shortcuts', title: 'Favoritos e recentes', wide: false },
] as const;

export type WidgetId = (typeof WIDGETS)[number]['id'];

export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

export interface WidgetState {
  id: WidgetId;
  title: string;
  wide: boolean;
  visible: boolean;
}

/**
 * Aplica a disposição guardada: primeiro os widgets pela ordem guardada, depois os novos (ainda não ordenados) pela
 * ordem por omissão. Ids desconhecidos (widgets retirados) são ignorados.
 */
export function arrange(layout: DashboardLayout | null): WidgetState[] {
  const known = new Map<string, (typeof WIDGETS)[number]>(WIDGETS.map((w) => [w.id, w]));
  const hidden = new Set(layout?.hidden ?? []);
  const ordered = (layout?.order ?? []).filter(
    (id, i, all) => known.has(id) && all.indexOf(id) === i,
  );
  const rest = WIDGETS.map((w) => w.id).filter((id) => !ordered.includes(id));
  return [...ordered, ...rest].map((id) => {
    const w = known.get(id)!;
    return { id: w.id, title: w.title, wide: w.wide, visible: !hidden.has(id) };
  });
}

/** Disposição a guardar a partir do estado editado. */
export function toLayout(states: WidgetState[]): DashboardLayout {
  return {
    order: states.map((s) => s.id),
    hidden: states.filter((s) => !s.visible).map((s) => s.id),
  };
}

/** Move um widget uma posição (para cima: -1; para baixo: +1), sem sair dos limites. */
export function move(states: WidgetState[], index: number, delta: -1 | 1): WidgetState[] {
  const target = index + delta;
  if (target < 0 || target >= states.length) return states;
  const next = [...states];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
