import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { msgExactlyOne } from '../constants/validation';

export function Xor(property1: string, property2: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'Xor',
      target: object.constructor,
      propertyName,
      constraints: [property1, property2],
      options: validationOptions,
      validator: {
        validate(_: unknown, args: ValidationArguments) {
          const [p1, p2] = args.constraints as [string, string];
          const obj = args.object as Record<string, unknown>;
          const v1 = obj?.[p1];
          const v2 = obj?.[p2];
          const provided = [v1, v2].filter((v) => v !== undefined && v !== null);
          return provided.length === 1;
        },
        defaultMessage(args: ValidationArguments) {
          const [p1, p2] = args.constraints as [string, string];
          return msgExactlyOne(p1, p2);
        },
      },
    });
  };
}
