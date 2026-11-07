import { fold, matches } from './command-palette';

describe('paleta de comandos', () => {
  it('compara sem acentos nem maiúsculas', () => {
    expect(fold('Lançamentos Ação')).toBe('lancamentos acao');
  });

  it('todas as palavras têm de aparecer no rótulo, na dica ou no grupo', () => {
    const c = { label: 'Demonstrações financeiras', hint: 'Gestão Financeira', group: 'Ir para' };
    expect(matches(c, 'demonstracoes')).toBe(true);
    expect(matches(c, 'gestao demo')).toBe(true);
    expect(matches(c, 'demo razao')).toBe(false);
  });
});
