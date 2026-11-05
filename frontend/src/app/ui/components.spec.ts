import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { ApiError } from '../core/api';
import { unsavedChangesGuard } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { Autocomplete, type Option } from './autocomplete';
import { ConfirmService } from './confirm';
import { type Column, DataTable, type Sort } from './data-table';
import { Dropdown } from './dropdown';
import { PermissionGate } from './permission-gate';
import { Tabs } from './tabs';

const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

@Component({
  imports: [DataTable],
  template: `<app-data-table
    label="Teste"
    [columns]="columns"
    [rows]="rows()"
    [total]="rows().length"
    [sort]="sort()"
    [error]="error()"
    (sortChange)="sorted = $event"
    (retry)="retried = true"
  />`,
})
class TableHost {
  columns: Column<{ id: string; name: string }>[] = [
    { key: 'name', label: 'Nome', sortable: true },
  ];
  rows = signal<{ id: string; name: string }[]>([]);
  sort = signal<Sort | null>({ field: 'name', direction: 'asc' });
  error = signal<ApiError | null>(null);
  sorted: Sort | null = null;
  retried = false;
}

describe('DataTable', () => {
  it('anuncia a ordenação, alterna o sentido e mostra estados vazio e de erro', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const f = TestBed.createComponent(TableHost);
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(el.textContent).toContain('Sem registos.');
    el.querySelector<HTMLButtonElement>('th button')!.click();
    expect(f.componentInstance.sorted).toEqual({ field: 'name', direction: 'desc' });

    f.componentInstance.rows.set([{ id: '1', name: 'Ana' }]);
    await f.whenStable();
    expect(el.querySelector('tbody')!.textContent).toContain('Ana');

    f.componentInstance.error.set(new ApiError(500, 'X', 'Falhou', [], 'req-1'));
    await f.whenStable();
    expect(el.querySelector('[role=alert]')!.textContent).toContain('req-1');
    el.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    expect(f.componentInstance.retried).toBe(true);
  });
});

@Component({
  imports: [Dropdown],
  template: `<app-dropdown label="Menu"
    ><span trigger>Abrir</span><button role="menuitem">Um</button
    ><button role="menuitem">Dois</button></app-dropdown
  >`,
})
class DropdownHost {}

describe('Dropdown', () => {
  it('abre com foco no primeiro item, percorre com setas e fecha com Escape devolvendo o foco', async () => {
    const f = TestBed.createComponent(DropdownHost);
    document.body.appendChild(f.nativeElement);
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;
    trigger.click();
    await f.whenStable();
    await new Promise((r) => setTimeout(r));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = el.querySelectorAll<HTMLElement>('[role=menuitem]');
    expect(document.activeElement).toBe(items[0]);
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'Escape');
    await f.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    f.nativeElement.remove();
  });
});

@Component({
  imports: [Tabs],
  template: `<app-tabs label="Secções" [tabs]="tabs" [(active)]="active" />`,
})
class TabsHost {
  tabs = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  active = 'a';
}

describe('Tabs', () => {
  it('só o separador activo é tabulável e as setas mudam de separador', async () => {
    const f = TestBed.createComponent(TabsHost);
    await f.whenStable();
    const tabs = (f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[role=tab]');
    expect([...tabs].map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1']);
    key(tabs[0], 'ArrowRight');
    await f.whenStable();
    expect(f.componentInstance.active).toBe('b');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });
});

@Component({
  imports: [Autocomplete, FormsModule],
  template: `<app-autocomplete inputId="ac" [search]="search" [(ngModel)]="value" />`,
})
class AutocompleteHost {
  value: string | null = null;
  search = async (q: string): Promise<Option[]> =>
    [
      { id: '1', label: 'Ana' },
      { id: '2', label: 'Bruno' },
    ].filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
}

describe('Autocomplete', () => {
  it('procura, navega com setas e escolhe com Enter', async () => {
    const f = TestBed.createComponent(AutocompleteHost);
    await f.whenStable();
    const input = (f.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#ac')!;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    await f.whenStable();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    key(input, 'ArrowDown');
    await f.whenStable();
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    key(input, 'Enter');
    await f.whenStable();
    expect(f.componentInstance.value).toBe('2');
    expect(input.value).toBe('Bruno');
  });
});

@Component({
  imports: [PermissionGate],
  template: `<p *appCan="'roles.manage'">gerir</p>
    <p *appCan="'audit.read'; feature: 'approvals'">aprovar</p>`,
})
class GateHost {}

describe('PermissionGate', () => {
  it('mostra só com a permissão e a funcionalidade', async () => {
    const workspace = TestBed.inject(Workspace);
    const f = TestBed.createComponent(GateHost);
    await f.whenStable();
    expect((f.nativeElement as HTMLElement).textContent).toBe('');
    workspace.permissions.set(new Set(['roles.manage', 'audit.read']));
    await f.whenStable();
    expect((f.nativeElement as HTMLElement).textContent).toContain('gerir');
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('aprovar');
  });
});

describe('Confirmação e alterações por guardar', () => {
  it('a confirmação resolve com a resposta e o guard só pergunta com alterações', async () => {
    const confirm = TestBed.inject(ConfirmService);
    const clean = TestBed.runInInjectionContext(() =>
      unsavedChangesGuard(
        { hasUnsavedChanges: () => false },
        null as never,
        null as never,
        null as never,
      ),
    );
    expect(clean).toBe(true);
    const dirty = TestBed.runInInjectionContext(() =>
      unsavedChangesGuard(
        { hasUnsavedChanges: () => true },
        null as never,
        null as never,
        null as never,
      ),
    ) as Promise<boolean>;
    expect(confirm.current()?.title).toBe('Alterações por guardar');
    confirm.answer(false);
    expect(await dirty).toBe(false);
  });
});

describe('Workspace ao mudar de empresa', () => {
  it('esquece âmbito e cache da empresa anterior', async () => {
    const workspace = TestBed.inject(Workspace);
    workspace.tenantId.set('a');
    workspace.legalEntityId.set('le-a');
    let calls = 0;
    await workspace.cached('k', async () => ++calls);
    await workspace.cached('k', async () => ++calls);
    expect(calls).toBe(1);
    workspace.reset();
    expect(workspace.legalEntityId()).toBeNull();
    workspace.tenantId.set('a');
    await workspace.cached('k', async () => ++calls);
    expect(calls).toBe(2);
  });
});
