import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { parseDeliveryChannel } from '../delivery/delivery-channel';

@ValidatorConstraint({ name: 'isValidChannelPreferences', async: false })
export class IsValidChannelPreferencesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (Array.isArray(value)) {
      if (value.length > 6) return false;

      const parsedChannels = value.map(parseDeliveryChannel);

      return (
        parsedChannels.every((channel) => channel !== null) &&
        new Set(parsedChannels).size === parsedChannels.length
      );
    }

    if (
      value === null ||
      typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }

    const entries = Object.entries(value);

    if (entries.length > 6) return false;

    const parsedChannels = entries.map(([key, enabled]) => {
      if (typeof enabled !== 'boolean') return null;
      return parseDeliveryChannel(key);
    });

    return (
      parsedChannels.every((channel) => channel !== null) &&
      new Set(parsedChannels).size === parsedChannels.length
    );
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'channels must contain valid delivery channels with boolean values';
  }
}

export function IsValidChannelPreferences(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'isValidChannelPreferences',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: IsValidChannelPreferencesConstraint,
    });
  };
}
