import { HttpException, HttpStatus } from '@nestjs/common';

export class RedirectException extends HttpException {
  constructor(public readonly url: string) {
    super('Moved Permanently', HttpStatus.MOVED_PERMANENTLY);
  }
}
