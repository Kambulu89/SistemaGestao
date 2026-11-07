import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Attachments, formatSize, MAX_BYTES } from './attachments';

describe('Attachments', () => {
  it('recusa no browser ficheiros acima de 10 MB sem os enviar', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Attachments);
    fixture.componentRef.setInput('subjectType', 'legal_entity');
    fixture.componentRef.setInput('subjectId', 'x');
    fixture.componentRef.setInput('canWrite', true);
    fixture.detectChanges();
    http.expectOne((r) => r.url === '/api/v1/attachments').flush({ data: [] });
    await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#file')!;
    const big = new File([new Uint8Array(MAX_BYTES + 1)], 'grande.pdf');
    Object.defineProperty(input, 'files', { value: [big] });
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('mais de 10 MB');
    http.expectNone((r) => r.method === 'POST');
  });

  it('formata tamanhos', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
