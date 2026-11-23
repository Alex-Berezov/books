import { Inject, Injectable, Logger } from '@nestjs/common';
import { LlmTask } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../../shared/storage/storage.interface';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { readStoredAnalysis } from '../../book-analysis/book-analysis-data';
import { checkImageBase64, IMAGE_TOO_LARGE } from '../../llm/llm-image';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { ILLUSTRATIONS_KEY_PREFIX, uploadObjectKey } from '../../uploads/uploads.service';
import {
  WORLD_IMAGE_ASPECT_RATIO,
  WORLD_IMAGE_INPUT_MISSING,
  WORLD_IMAGE_LIMITS,
  WORLD_IMAGE_RESERVE_USD,
  WORLD_IMAGE_STAGE,
} from './world-image.constants';
import { worldPortraitPrompt } from './world-image.prompt';
import { lockImageRow, portraitSubject } from './world-image.service';

/**
 * Шаг генерации иллюстрации (`F08-11a`): один вызов этапа `world_image`, проверка байтов (Р1),
 * файл в хранилище, `MediaAsset` и ожидающая ячейка строки - в транзакции завершения операции.
 * Отказ - операция `failed`, причина - код задачи; принятая картинка не трогается никогда.
 */
@Injectable()
export class WorldImageHandler {
  private readonly logger = new Logger(WorldImageHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    // Отказ шага (деньги, провайдер, исчерпанные захваты) - операция `failed`: «Continue» у
    // генерации картинки нет, следующая - снова кнопкой.
    onFailed: async (task) => {
      await this.tasks.failOperation(task.operationId);
    },
  };

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const key =
      isRecord(task.payload) && typeof task.payload.key === 'string' ? task.payload.key : null;
    const entity =
      key && task.bookVersionId
        ? await this.prisma.bookWorldEntity.findUnique({
            where: { bookVersionId_key: { bookVersionId: task.bookVersionId, key } },
            select: {
              type: true,
              role: true,
              blocks: true,
              bookVersion: {
                select: { bookId: true, analyses: { select: { facts: true }, take: 1 } },
              },
            },
          })
        : null;
    const subject = entity ? portraitSubject(entity) : null;
    if (!key || !entity || !subject?.allowed || !subject.appearance) {
      return this.fail(task, WORLD_IMAGE_INPUT_MISSING);
    }
    const analysis = entity.bookVersion.analyses[0];
    const facts = readStoredAnalysis({ facts: analysis?.facts ?? null }).facts;
    const prompt = worldPortraitPrompt({
      appearance: subject.appearance,
      settingPlace: facts?.settingPlace,
      settingTime: facts?.settingTime,
    });
    const answer = await this.llm.callImageStage(
      task.operationId,
      WORLD_IMAGE_STAGE,
      prompt,
      { reserveUsd: WORLD_IMAGE_RESERVE_USD, aspectRatio: WORLD_IMAGE_ASPECT_RATIO },
      ctx.callOptions,
    );
    const checked = answer.oversize
      ? ({ ok: false, reason: IMAGE_TOO_LARGE } as const)
      : checkImageBase64(answer.base64, WORLD_IMAGE_LIMITS);
    if (!checked.ok) return this.fail(task, checked.reason);

    // Ключ - только серверный. Файл ложится до транзакции, `MediaAsset` и ожидающая ячейка -
    // одной транзакцией завершения операции: строки без ссылки не бывает. Результат не лёг
    // (операцию отменили, строку ведёт другая генерация) - файл удаляется сразу.
    const objectKey = uploadObjectKey(ILLUSTRATIONS_KEY_PREFIX, checked.info.ext);
    await this.storage.save(objectKey, checked.bytes, { contentType: checked.info.mime });
    let linked = false;
    let committed = false;
    const linking = this.tasks.completeOperation(task.operationId, async (tx) => {
      const row = await lockImageRow(tx, subject.bookId, key);
      // Строку уже ведёт другая генерация: этот результат не её - ячейку не трогать.
      if (row.operationId !== task.operationId) return;
      const asset = await tx.mediaAsset.create({
        data: {
          key: objectKey,
          url: this.storage.getPublicUrl(objectKey),
          contentType: checked.info.mime,
          size: checked.bytes.length,
          width: checked.info.width,
          height: checked.info.height,
        },
        select: { id: true },
      });
      await tx.bookWorldImage.update({ where: { id: row.id }, data: { pendingMediaId: asset.id } });
      linked = true;
    });
    try {
      committed = await linking;
    } finally {
      // Не легло - отказ, чужая генерация или сбой транзакции (запись в колбэке откатилась вместе
      // с ней): файл без `MediaAsset` уборка не увидит, удаляется сразу.
      if (!(committed && linked)) await this.dropFile(objectKey);
    }
    return { kind: 'done' };
  }

  /** Файл результата, который не лёг в строку: удалить; сбой - в лог, уборке он не виден. */
  private async dropFile(objectKey: string): Promise<void> {
    try {
      await this.storage.delete(objectKey);
    } catch (error) {
      this.logger.warn(
        `World image file was not removed: key=${objectKey} error=${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }

  private async fail(task: LlmTask, reason: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(task.operationId);
    return { kind: 'fail', reason };
  }
}
