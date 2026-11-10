import { describe, expect, it } from 'vitest';
import { ConfirmService } from './confirm';

describe('ConfirmService', () => {
  it('uma resposta atrasada do diálogo anterior não cancela o pedido seguinte', async () => {
    const s = new ConfirmService();
    const first = s.ask({ title: 'A', message: 'a' });
    const req1 = s.current()!;
    s.answerFor(req1, true);
    await expect(first).resolves.toBe(true);
    const second = s.ask({ title: 'B', message: 'b' });
    // O evento "close" do primeiro diálogo chega agora: não pode responder ao segundo.
    s.answerFor(req1, false);
    expect(s.current()?.title).toBe('B');
    s.answerFor(s.current()!, true);
    await expect(second).resolves.toBe(true);
  });

  it('um novo pedido recusa o que estava aberto', async () => {
    const s = new ConfirmService();
    const first = s.ask({ title: 'A', message: 'a' });
    const second = s.ask({ title: 'B', message: 'b' });
    await expect(first).resolves.toBe(false);
    s.answer(true);
    await expect(second).resolves.toBe(true);
  });
});
