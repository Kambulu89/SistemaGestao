import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Shell } from './shell';

@Component({
  imports: [Shell],
  template: `<app-shell><span shellNav>menu</span>conteúdo</app-shell>`,
})
class Host {}

describe('Shell', () => {
  it('opens the drawer from the header button and closes it with Escape', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const aside = el.querySelector('aside');

    expect(aside?.classList.contains('invisible')).toBe(true);

    el.querySelector<HTMLButtonElement>('button[aria-label="Abrir menu de navegação"]')?.click();
    await fixture.whenStable();
    expect(aside?.classList.contains('invisible')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(aside?.classList.contains('invisible')).toBe(true);
  });
});
