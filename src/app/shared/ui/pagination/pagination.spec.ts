import { TestBed } from '@angular/core/testing';
import { Pagination } from './pagination';

describe('Pagination', () => {
  it('shows the range and disables prev on the first page', async () => {
    const fixture = TestBed.createComponent(Pagination);
    fixture.componentRef.setInput('page', 1);
    fixture.componentRef.setInput('pageSize', 8);
    fixture.componentRef.setInput('total', 27);
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('1–8 de 27');
    expect(el.textContent).toContain('Página 1 de 4');
    expect(
      el.querySelector<HTMLButtonElement>('button[aria-label="Página anterior"]')?.disabled,
    ).toBe(true);
  });

  it('emits the next page', async () => {
    const fixture = TestBed.createComponent(Pagination);
    fixture.componentRef.setInput('page', 1);
    fixture.componentRef.setInput('pageSize', 8);
    fixture.componentRef.setInput('total', 27);
    const emitted: number[] = [];
    fixture.componentInstance.pageChange.subscribe((p) => emitted.push(p));
    await fixture.whenStable();

    fixture.nativeElement.querySelector('button[aria-label="Página seguinte"]').click();
    expect(emitted).toEqual([2]);
  });
});
