import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MainLayout } from './main-layout';

describe('MainLayout', () => {
  it('opens and closes the sidebar from the header menu button', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(MainLayout);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const sidebar = el.querySelector('aside');

    expect(sidebar?.classList.contains('invisible')).toBe(true);

    el.querySelector<HTMLButtonElement>('button[aria-label="Abrir menu de navegação"]')?.click();
    await fixture.whenStable();
    expect(sidebar?.classList.contains('invisible')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(sidebar?.classList.contains('invisible')).toBe(true);
  });
});
