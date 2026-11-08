import { MAX_FAVORITES, MAX_RECENTS, cleanPath, pushRecent, toggleFavorite } from './personal';

describe('favoritos e recentes', () => {
  it('só guarda caminhos internos, sem query nem fragmento', () => {
    expect(cleanPath('/contabilidade/lancamentos?page=2#x')).toBe('/contabilidade/lancamentos');
    expect(cleanPath('https://exemplo.ao/x')).toBeNull();
    expect(cleanPath('/a b')).toBeNull();
  });

  it('recentes: mais recente primeiro, sem repetidos e com limite', () => {
    let list = Array.from({ length: MAX_RECENTS }, (_, i) => ({ path: `/p${i}`, title: `P${i}` }));
    list = pushRecent(list, { path: '/p3', title: 'Nome novo' });
    expect(list[0]).toEqual({ path: '/p3', title: 'Nome novo' });
    expect(list.filter((p) => p.path === '/p3')).toHaveLength(1);
    list = pushRecent(list, { path: '/novo', title: 'Novo' });
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].path).toBe('/novo');
  });

  it('favoritos: alternar acrescenta no fim e retira; respeita o limite', () => {
    const a = { path: '/a', title: 'A' };
    expect(toggleFavorite([], a)).toEqual([a]);
    expect(toggleFavorite([a], a)).toEqual([]);
    const full = Array.from({ length: MAX_FAVORITES }, (_, i) => ({ path: `/f${i}`, title: 'F' }));
    expect(toggleFavorite(full, a)).toHaveLength(MAX_FAVORITES);
  });
});
