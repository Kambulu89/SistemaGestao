import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HealthService, type Health } from '../core/health.service';
import { Home } from './home';

async function render(check: () => ReturnType<HealthService['check']>) {
  TestBed.configureTestingModule({ providers: [{ provide: HealthService, useValue: { check } }] });
  const fixture = TestBed.createComponent(Home);
  await fixture.whenStable();
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('[data-testid=api-status]')!;
}

describe('Home', () => {
  it('mostra a API disponível e a base de dados ligada', async () => {
    const status = await render(() => of<Health>({ status: 'ok', database: 'up' }));
    expect(status.textContent).toContain('Disponível');
    expect(status.textContent).toContain('ligada');
  });

  it('mostra indisponível quando o pedido falha', async () => {
    const status = await render(() => throwError(() => new Error('rede')));
    expect(status.textContent).toContain('Indisponível');
  });
});
