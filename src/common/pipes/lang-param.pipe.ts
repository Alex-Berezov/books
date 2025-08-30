import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import { Language } from '@prisma/client';

@Injectable()
export class LangParamPipe implements PipeTransform<string, Language> {
  private readonly allowed = new Set<string>(Object.values(Language));

  transform(value: string): Language {
    const v = (value || '').toLowerCase();
    if (this.allowed.has(v)) return v as Language;
    // 404, чтобы не раскрывать структуру маршрутов
    throw new NotFoundException('Route not found');
  }
}
