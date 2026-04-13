import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

export function createValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) => {
      const formattedErrors = errors.map((error) => {
        const messages = Object.values(error.constraints || {});
        return {
          field: error.property,
          errors: messages,
        };
      });
      
      console.error('[ValidationPipe] Validation errors:', formattedErrors);
      
      return new BadRequestException({
        message: 'Validation failed',
        details: formattedErrors,
      });
    },
  });
}
