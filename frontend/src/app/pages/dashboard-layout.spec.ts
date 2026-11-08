import { WIDGETS, arrange, move, toLayout } from './dashboard-layout';

describe('disposição do painel', () => {
  it('sem preferência usa a ordem por omissão com tudo visível', () => {
    const states = arrange(null);
    expect(states.map((s) => s.id)).toEqual(WIDGETS.map((w) => w.id));
    expect(states.every((s) => s.visible)).toBe(true);
  });

  it('aplica a ordem guardada, esconde, ignora ids desconhecidos e acrescenta os novos', () => {
    const states = arrange({ order: ['tasks', 'retirado', 'kpis', 'tasks'], hidden: ['usage'] });
    expect(states.slice(0, 2).map((s) => s.id)).toEqual(['tasks', 'kpis']);
    expect(states).toHaveLength(WIDGETS.length);
    expect(states.find((s) => s.id === 'usage')!.visible).toBe(false);
  });

  it('mover e converter de volta', () => {
    const states = arrange(null);
    expect(move(states, 0, -1)).toBe(states);
    const moved = move(states, 0, 1);
    expect(moved[1].id).toBe('kpis');
    const layout = toLayout(moved.map((s) => (s.id === 'activity' ? { ...s, visible: false } : s)));
    expect(layout.order[1]).toBe('kpis');
    expect(layout.hidden).toEqual(['activity']);
  });
});
