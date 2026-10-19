import { TestBed } from '@angular/core/testing';
import { Home } from './home';

describe('Home', () => {
  it('renders the heading and increments the signal counter', async () => {
    const fixture = TestBed.createComponent(Home);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('h1')?.textContent).toContain('Base do projecto pronta');

    const increment = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Incrementar'),
    );
    increment?.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('Cliques: 1');
  });
});
