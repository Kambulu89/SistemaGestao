import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Input } from './input';

@Component({
  imports: [Input, ReactiveFormsModule],
  template: `<app-input label="Email" [formControl]="control" />`,
})
class Host {
  readonly control = new FormControl('', { nonNullable: true, validators: [Validators.required] });
}

describe('Input', () => {
  it('syncs with Reactive Forms and shows the error once touched', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input') as HTMLInputElement;

    expect(el.textContent).not.toContain('Campo obrigatório.');

    fixture.componentInstance.control.markAsTouched();
    await fixture.whenStable();
    expect(el.textContent).toContain('Campo obrigatório.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(fixture.componentInstance.control.value).toBe('x');
    expect(el.textContent).not.toContain('Campo obrigatório.');
    expect(el.querySelector('label')?.textContent).toContain('Email');
  });
});
