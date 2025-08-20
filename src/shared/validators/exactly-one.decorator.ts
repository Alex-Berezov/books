import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { msgExactlyOneOf } from '../constants/validation';

export function ExactlyOne(props: string[], options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'ExactlyOne',
      target: object.constructor,
      propertyName,
      constraints: props,
      options,
      validator: {
        validate(_: unknown, args: ValidationArguments): boolean {
          const list = (args.constraints as string[]) || [];
          const obj = args.object as Record<string, unknown>;
          const provided = list.filter((p) => obj[p] !== undefined && obj[p] !== null);
          return provided.length === 1;
        },
        defaultMessage(args: ValidationArguments): string {
          const list = (args.constraints as string[]) || [];
          return msgExactlyOneOf(list);
        },
      },
    });
  };
}
