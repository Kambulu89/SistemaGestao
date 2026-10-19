import { TestBed } from '@angular/core/testing';
import { Button } from './button';

describe('Button', () => {
  it('applies the variant classes and disables the native button', async () => {
    const fixture = TestBed.createComponent(Button);
    fixture.componentRef.setInput('variant', 'secondary');
    fixture.componentRef.setInput('disabled', true);
    await fixture.whenStable();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.className).toContain('border-line');
  });

  it('is disabled and busy while loading', async () => {
    const fixture = TestBed.createComponent(Button);
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });
});
