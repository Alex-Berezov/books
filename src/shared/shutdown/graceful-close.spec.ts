import { Logger } from '@nestjs/common';
import { closeWithin } from './graceful-close';

/**
 * 🔴 `LEGACY-364`. Сторож самого приёма: без него «превышение срока пишется
 * в лог» держалось только на глазах — вернуть тихий `catch {}` можно было
 * незаметно для всех проверок.
 */
describe('closeWithin', () => {
  // Мок держится отдельной ссылкой: обращение к `logger.warn` через объект —
  // несвязанный метод, и линт справедливо на это ругается.
  const makeLogger = () => {
    const warn = jest.fn();
    return { logger: { warn } as unknown as Logger, warn };
  };

  it('возвращается, не дождавшись зависшего закрытия, и говорит об этом в лог', async () => {
    const { logger, warn } = makeLogger();
    const started = Date.now();

    await closeWithin(logger, 'вечная связь', () => new Promise<void>(() => {}), 50);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('вечная связь');
  });

  it('отказ не пробрасывается наружу, но попадает в лог', async () => {
    const { logger, warn } = makeLogger();

    await expect(
      closeWithin(logger, 'очередь', () => Promise.reject(new Error('связь потеряна'))),
    ).resolves.toBeUndefined();

    expect(String(warn.mock.calls[0][0])).toContain('связь потеряна');
  });

  it('успешное закрытие молчит', async () => {
    const { logger, warn } = makeLogger();

    await closeWithin(logger, 'очередь', () => Promise.resolve());

    expect(warn).not.toHaveBeenCalled();
  });

  it('переживает ресурс, которого нет', async () => {
    // Локальный прогон без Redis: провайдеры отдают undefined.
    const { logger, warn } = makeLogger();

    await expect(closeWithin(logger, 'нет ресурса', () => undefined)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * Поздний отказ уже проигравшего гонку промиса не должен ронять процесс
   * необработанным отклонением: `Promise.race` подписан на оба.
   */
  it('поздний отказ после срока не остаётся необработанным', async () => {
    const { logger } = makeLogger();
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);

    await closeWithin(
      logger,
      'поздний отказ',
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('поздно')), 30)),
      5,
    );
    await new Promise((r) => setTimeout(r, 80));

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
