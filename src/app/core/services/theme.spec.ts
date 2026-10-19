import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to the system preference', () => {
    expect(TestBed.inject(ThemeService).preference()).toBe('system');
  });

  it('cycles light → dark → system and persists the choice', () => {
    const service = TestBed.inject(ThemeService);
    service.set('light');
    service.cycle();
    expect(service.preference()).toBe('dark');
    expect(localStorage.getItem('sg-theme')).toBe('dark');
    service.cycle();
    expect(service.preference()).toBe('system');
  });

  it('toggles the dark class on <html>', () => {
    const service = TestBed.inject(ThemeService);
    service.set('dark');
    TestBed.tick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    service.set('light');
    TestBed.tick();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
