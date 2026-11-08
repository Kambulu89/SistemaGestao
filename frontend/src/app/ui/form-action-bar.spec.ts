import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormActionBar } from './form-action-bar';

@Component({
  imports: [FormActionBar],
  template: `<form id="f" (submit)="$event.preventDefault(); submitted = submitted + 1"></form>
    <app-form-action-bar formId="f" [dirty]="dirty()" [busy]="busy()" saveLabel="Guardar perfil">
      <button type="button" class="extra">Eliminar</button>
    </app-form-action-bar>`,
})
class Host {
  dirty = signal(false);
  busy = signal(false);
  submitted = 0;
}

describe('FormActionBar', () => {
  it('mostra alterações por guardar, acções extra e impede submissão dupla', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.textContent?.trim()).toBe('Guardar perfil');
    expect(submit.getAttribute('form')).toBe('f');
    expect(el.textContent).not.toContain('Alterações por guardar');
    expect(el.querySelector('.extra')).not.toBeNull();

    fixture.componentInstance.dirty.set(true);
    fixture.componentInstance.busy.set(true);
    fixture.detectChanges();
    expect(el.textContent).toContain('Alterações por guardar');
    expect(submit.disabled).toBe(true);
    expect(submit.textContent?.trim()).toBe('A guardar…');
  });
});
