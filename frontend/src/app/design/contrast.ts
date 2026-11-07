/** Contraste WCAG 2.x entre duas cores `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Lê as variáveis `--c-*` de um bloco CSS (`:root` ou `[data-theme='dark']`). */
export function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Bloco não encontrado: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--c-([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
}

/** Pares obrigatórios: texto 4.5:1; indicadores de foco e limites de campos 3:1 (WCAG 1.4.3 e 1.4.11). */
export const REQUIRED_PAIRS: [fg: string, bg: string, min: number][] = [
  ['fg', 'bg', 4.5],
  ['fg', 'surface', 4.5],
  ['fg', 'surface-2', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface-2', 4.5],
  ['subtle', 'surface', 4.5],
  ['link', 'surface', 4.5],
  ['link', 'bg', 4.5],
  ['on-primary', 'primary', 4.5],
  ['on-primary', 'primary-hover', 4.5],
  ['on-primary-soft', 'primary-soft', 4.5],
  ['on-danger', 'danger', 4.5],
  ['on-danger', 'danger-hover', 4.5],
  ['danger-text', 'danger-soft', 4.5],
  ['danger-text', 'surface', 4.5],
  ['success-text', 'success-soft', 4.5],
  ['warning-text', 'warning-soft', 4.5],
  ['info-text', 'info-soft', 4.5],
  ['focus', 'surface', 3],
  ['focus', 'bg', 3],
  ['border-strong', 'surface', 3],
  // Cores de estado usadas em ícones, barras e indicadores (componentes, 3:1); o texto usa os pares `*-text`.
  ['interactive', 'surface', 3],
  ['success', 'surface', 3],
  ['warning', 'surface', 3],
  ['danger', 'surface', 3],
  ['primary', 'surface', 3],
  ['link', 'surface-2', 4.5],
];
