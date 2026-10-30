import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ChartPoint } from './reporting-model';

const PALETTE = [
  '#4f46e5',
  '#0891b2',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#9333ea',
  '#64748b',
  '#db2777',
];

/**
 * Gráficos simples em SVG (barras, linha e circular), sem dependências. Os valores só definem tamanhos e ângulos;
 * cada ponto tem um título acessível e a lista com os valores continua disponível para leitores de ecrã.
 */
@Component({
  selector: 'app-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (points().length === 0) {
      <p class="text-sm text-fg-muted">Sem dados.</p>
    } @else {
      <svg
        viewBox="0 0 320 160"
        class="h-40 w-full"
        role="img"
        [attr.aria-label]="label()"
        data-testid="chart"
      >
        @switch (kind()) {
          @case ('BAR') {
            @for (bar of bars(); track bar.label) {
              <rect
                [attr.x]="bar.x"
                [attr.y]="bar.y"
                [attr.width]="bar.w"
                [attr.height]="bar.h"
                [attr.fill]="bar.color"
              >
                <title>{{ bar.label }}: {{ bar.value }}</title>
              </rect>
            }
          }
          @case ('LINE') {
            <polyline fill="none" stroke="#4f46e5" stroke-width="2" [attr.points]="linePoints()" />
            @for (dot of dots(); track dot.label) {
              <circle [attr.cx]="dot.x" [attr.cy]="dot.y" r="3" fill="#4f46e5">
                <title>{{ dot.label }}: {{ dot.value }}</title>
              </circle>
            }
          }
          @case ('PIE') {
            @for (slice of slices(); track slice.label) {
              <path [attr.d]="slice.path" [attr.fill]="slice.color" stroke="white" stroke-width="1">
                <title>{{ slice.label }}: {{ slice.value }}</title>
              </path>
            }
          }
        }
      </svg>
      <ul class="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-muted" data-testid="chart-legend">
        @for (p of points(); track p.label; let i = $index) {
          <li>
            <span class="inline-block size-2 rounded-full" [style.background]="color(i)"></span>
            {{ p.label }}: {{ p.value }}
          </li>
        }
      </ul>
    }
  `,
})
export class Chart {
  readonly kind = input.required<'BAR' | 'LINE' | 'PIE'>();
  readonly points = input.required<readonly ChartPoint[]>();
  readonly label = input('Gráfico');

  protected color = (i: number) => PALETTE[i % PALETTE.length] as string;
  private readonly max = computed(() =>
    Math.max(1, ...this.points().map((p) => Math.abs(p.value))),
  );

  protected readonly bars = computed(() => {
    const pts = this.points();
    const slot = 300 / Math.max(pts.length, 1);
    return pts.map((p, i) => {
      const h = (Math.abs(p.value) / this.max()) * 140;
      return {
        label: p.label,
        value: p.value,
        x: 10 + i * slot + slot * 0.15,
        y: 150 - h,
        w: slot * 0.7,
        h,
        color: this.color(i),
      };
    });
  });

  protected readonly dots = computed(() => {
    const pts = this.points();
    const step = pts.length > 1 ? 300 / (pts.length - 1) : 0;
    return pts.map((p, i) => ({
      label: p.label,
      value: p.value,
      x: 10 + i * step,
      y: 150 - (Math.abs(p.value) / this.max()) * 140,
    }));
  });

  protected readonly linePoints = computed(() =>
    this.dots()
      .map((d) => `${d.x},${d.y}`)
      .join(' '),
  );

  protected readonly slices = computed(() => {
    const pts = this.points().filter((p) => p.value > 0);
    const total = pts.reduce((sum, p) => sum + p.value, 0);
    if (total <= 0) return [];
    let angle = -Math.PI / 2;
    return pts.map((p, i) => {
      const sweep = (p.value / total) * Math.PI * 2;
      const [x1, y1] = [160 + 70 * Math.cos(angle), 80 + 70 * Math.sin(angle)];
      angle += sweep;
      const [x2, y2] = [160 + 70 * Math.cos(angle), 80 + 70 * Math.sin(angle)];
      const large = sweep > Math.PI ? 1 : 0;
      const path =
        pts.length === 1
          ? 'M160 10a70 70 0 1 1 0 140a70 70 0 1 1 0-140Z'
          : `M160 80L${x1} ${y1}A70 70 0 ${large} 1 ${x2} ${y2}Z`;
      return { label: p.label, value: p.value, path, color: this.color(i) };
    });
  });
}
