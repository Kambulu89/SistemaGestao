import { REQUIRED_PAIRS, contrast, tokensOf } from './contrast';

/** Os testes correm em Node (Vitest): lê-se a folha de estilos real, que é a fonte de verdade dos tokens. */
const nodeFs = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(path: string, encoding: string): string;
};
const css = readFileSync('src/styles.css', 'utf8');

describe('tokens de cor (WCAG 2.2 AA)', () => {
  it('calcula o contraste de referência', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  for (const [theme, selector] of [
    ['claro', ':root'],
    ['escuro', "[data-theme='dark']"],
  ] as const) {
    it(`tema ${theme}: todos os pares obrigatórios cumprem o mínimo`, () => {
      const tokens = tokensOf(css, selector);
      const failures = REQUIRED_PAIRS.filter(([fg, bg, min]) => {
        if (!tokens[fg] || !tokens[bg]) return true;
        return contrast(tokens[fg], tokens[bg]) < min;
      }).map(([fg, bg, min]) => `${fg}/${bg} < ${min}`);
      expect(failures).toEqual([]);
    });
  }
});
