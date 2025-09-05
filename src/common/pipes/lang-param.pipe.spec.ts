import { LangParamPipe } from './lang-param.pipe';
import { NotFoundException } from '@nestjs/common';

describe('LangParamPipe', () => {
  const pipe = new LangParamPipe();

  it('passes for supported languages (case-insensitive)', () => {
    expect(pipe.transform('en')).toBe('en');
    expect(pipe.transform('FR')).toBe('fr');
  });

  it('throws NotFoundException for unsupported values', () => {
    expect(() => pipe.transform('xx')).toThrow(NotFoundException);
    expect(() => pipe.transform('')).toThrow(NotFoundException);
  });
});
