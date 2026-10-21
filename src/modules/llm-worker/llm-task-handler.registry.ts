import { Injectable } from '@nestjs/common';
import { LlmTaskHandler } from './llm-task.types';

/**
 * Реестр обработчиков `kind -> handler`: модули конвейера регистрируют свои виды задач
 * (`F05-2` и дальше). Захват берёт только зарегистрированные виды: задача незнакомого вида
 * лежит `pending`, пока её код не вернётся (решение арбитра `F05 | F05-1w`).
 */
@Injectable()
export class LlmTaskHandlerRegistry {
  private readonly handlers = new Map<string, LlmTaskHandler>();

  register(kind: string, handler: LlmTaskHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`LLM task handler for "${kind}" is already registered`);
    }
    this.handlers.set(kind, handler);
  }

  get(kind: string): LlmTaskHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }
}
