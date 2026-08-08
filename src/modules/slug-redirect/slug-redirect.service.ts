import { Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Типы сущностей, у которых слаг — публичный URL. Строки, а не enum: см. схему. */
export const SLUG_REDIRECT_ENTITY_TYPES = ['category', 'tag'] as const;
export type SlugRedirectEntityType = (typeof SLUG_REDIRECT_ENTITY_TYPES)[number];

/** Клиент внутри транзакции или обычный — запись обязана идти вместе со сменой слага. */
type PrismaLike = Prisma.TransactionClient | PrismaService;

export interface SlugChange {
  entityType: SlugRedirectEntityType;
  language: Language;
  oldSlug: string;
  newSlug: string;
}

/**
 * История слагов и разрешение старых адресов (LEGACY-062).
 *
 * Слаг таксономии — индексируемый публичный URL. Смена слага без редиректа теряет
 * накопленные поисковые сигналы и превращает внешние ссылки в 404, а заметно это
 * становится через недели, по падению трафика.
 */
@Injectable()
export class SlugRedirectService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Записать смену слага. Вызывать **в той же транзакции**, что и саму смену:
   * иначе возможен момент, когда слаг уже новый, а редиректа ещё нет.
   *
   * Три случая, каждый из которых ломает наивную реализацию:
   *
   * 1. **Цепочка.** A→B, затем B→C. Наивно получилось бы два звена, и браузер шёл бы
   *    A→B→C. Здесь записи, ведущие на B, переписываются на C: старый адрес всегда
   *    ведёт в конечную точку одним переходом.
   * 2. **Цикл.** A→B, затем B→A. После переписывания звено A→B стало бы A→A —
   *    редиректом на себя, то есть бесконечным циклом в браузере. Такие записи
   *    удаляются.
   * 3. **Слаг занят заново.** Если новый слаг совпал с чьим-то старым, запись
   *    `newSlug → …` устарела: адрес снова живой и должен открывать сущность, а не
   *    уводить куда-то. Такая запись удаляется.
   */
  async record(change: SlugChange, tx?: PrismaLike): Promise<void> {
    const db = tx ?? this.prisma;
    const { entityType, language, oldSlug, newSlug } = change;

    if (!oldSlug || !newSlug || oldSlug === newSlug) return;

    // (3) новый слаг снова живой — редирект с него больше не нужен
    await db.slugRedirect.deleteMany({ where: { entityType, language, oldSlug: newSlug } });

    // (1) цепочки: всё, что вело на прежний адрес, ведёт теперь на новый
    await db.slugRedirect.updateMany({
      where: { entityType, language, newSlug: oldSlug },
      data: { newSlug },
    });

    await db.slugRedirect.upsert({
      where: { entityType_language_oldSlug: { entityType, language, oldSlug } },
      create: { entityType, language, oldSlug, newSlug },
      update: { newSlug },
    });

    // (2) циклы отдельной уборки не требуют.
    //
    // Редиректом на самого себя может стать только строка, чей `oldSlug` равен новому
    // слагу: переписывание цепочек перевело бы её на адрес, равный её же старому. Ровно
    // эти строки удаляет шаг «новый слаг снова живой» — а значит, самоссылка не выживает.
    //
    // ⚠️ Порядок этих двух шагов роли не играет: множество строк одно и то же, удалит
    // их шаг до или после переписывания. Проверено мутацией — перестановка не роняет
    // ни одной посадки. Убрать удаление целиком **нельзя**: обмен слагами туда-обратно
    // тогда оставляет A→A и бесконечный переход в браузере (посадка «never leaves a
    // redirect pointing at itself» краснеет).
  }

  /**
   * Куда ведёт старый адрес. `null` — записи нет, и это нормальный ответ: страница
   * тогда честно отвечает 404, а не выдумывает назначение.
   */
  async resolve(
    entityType: SlugRedirectEntityType,
    language: Language,
    slug: string,
  ): Promise<string | null> {
    const row = await this.prisma.slugRedirect.findUnique({
      where: { entityType_language_oldSlug: { entityType, language, oldSlug: slug } },
      select: { newSlug: true },
    });
    return row?.newSlug ?? null;
  }
}
