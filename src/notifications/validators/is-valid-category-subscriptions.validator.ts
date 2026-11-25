import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({
  name: 'isValidCategorySubscriptions',
  async: false,
})
export class IsValidCategorySubscriptionsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }

    const entries = Object.entries(value);

    if (entries.length > 100) return false;

    return entries.every(
      ([key, enabled]) =>
        key.trim().length > 0 &&
        key.length <= 100 &&
        typeof enabled === 'boolean',
    );
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'categorySubscriptions must be an object with string keys and boolean values';
  }
}

export function IsValidCategorySubscriptions(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'isValidCategorySubscriptions',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: IsValidCategorySubscriptionsConstraint,
    });
  };
}
