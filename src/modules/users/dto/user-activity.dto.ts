import { ApiProperty } from '@nestjs/swagger';
import { CommentUserDto } from '../../comments/dto/comment-user.dto';

/**
 * Ответ `GET /users/me/activities` — комментарии автора с их родителем и
 * ветками ответов.
 *
 * 🔴 Класс заведён **возвращаемым типом** `UsersService.getActivities`, а не
 * декоративным объявлением рядом с маршрутом. Декоративный DTO — второй
 * источник истины о форме ответа, который разойдётся с маппером молча: ровно
 * так 04.09.2026 добавленное поле `isHidden` не попало в OpenAPI, потому что
 * форма ответа жила литералом в сервисе и документа у маршрута не было вовсе
 * (`LEGACY-133`, дополнение от 04.09.2026; решение арбитра 05.09.2026).
 *
 * ⚠️ Но объявленный тип закрывает **не всё**. Проверка на лишние свойства
 * у TypeScript работает только для свежих литералов: `user: comment.parent.user`
 * и `user: child.user` (`users.service.ts:615, 625`) — ссылки, и лишнее поле
 * в них пройдёт по структурной совместимости молча. Поэтому автор комментария
 * описан **не своим классом, а общим `CommentUserDto`**: расширят
 * `PUBLIC_COMMENT_USER_SELECT` — расходиться будет одно место, а не два
 * (`LEGACY-191` утекала почтой третьих лиц ровно через такое расхождение;
 * найдено ревью в этом заходе).
 */

/** Книга, к которой относится комментарий: своя, главы или аудиоглавы. */
export class ActivityBookVersionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  author!: string;

  @ApiProperty({ nullable: true, type: String, format: 'uri' })
  coverImageUrl!: string | null;

  @ApiProperty({ description: 'Slug of the book the version belongs to' })
  slug!: string;
}

/**
 * Соседний комментарий в ветке — и родитель, и ответ.
 *
 * Один класс на оба, а не два одинаковых: маппер собирает их одинаково
 * (`users.service.ts:610-626`), и двумя классами они разъехались бы в OpenAPI
 * при неизменившемся ответе (найдено ревью в этом заходе).
 */
export class ActivityCommentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: CommentUserDto })
  user!: CommentUserDto;
}

export class UserActivityDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  text!: string;

  /**
   * Запись скрыта модератором. Скрытый **собственный** корень остаётся в
   * выдаче — иначе модерация неотличима от пропажи данных (`LEGACY-212`);
   * наружу уходит только сам признак, без причины и без имени модератора.
   */
  @ApiProperty()
  isHidden!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  parentId!: string | null;

  /**
   * ⚠️ `@ApiProperty({ nullable: true })`, а не `@ApiPropertyOptional`: маппер
   * кладёт ключ **всегда** (`users.service.ts:601-617`), в отсутствие данных —
   * `null`. `required: false` завёл бы у клиента ветку «ключа нет», которая
   * не выполнится ни на одном ответе (найдено ревью в этом заходе).
   */
  @ApiProperty({ type: ActivityBookVersionDto, nullable: true })
  bookVersion!: ActivityBookVersionDto | null;

  @ApiProperty({ type: ActivityCommentDto, nullable: true })
  parent!: ActivityCommentDto | null;

  /** Под скрытым корнем — только собственные ответы автора (`LEGACY-212`). */
  @ApiProperty({ type: ActivityCommentDto, isArray: true })
  replies!: ActivityCommentDto[];
}
