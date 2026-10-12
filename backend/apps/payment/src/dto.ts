import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_AMOUNT, MIN_AMOUNT } from '@app/common';
import { PAYMENT_STATUSES } from './domain/state-machine';

export class CreatePaymentIntentDto {
  /** Amount in the smallest currency unit (paise). ₹499.00 = 49900. */
  @IsInt({ message: 'amount must be an integer number of paise (e.g. 49900 for ₹499.00)' })
  @Min(MIN_AMOUNT, { message: `amount must be at least ${MIN_AMOUNT} paise (₹1.00)` })
  @Max(MAX_AMOUNT, { message: `amount must be at most ${MAX_AMOUNT} paise (₹5,00,000)` })
  amount: number;

  @IsOptional()
  @IsIn(['INR'], { message: 'currency must be INR' })
  currency?: string;

  @IsOptional()
  @IsIn(['automatic', 'manual'])
  capture_method?: 'automatic' | 'manual';

  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @IsOptional()
  @IsEmail()
  customer_email?: string;

  @IsOptional()
  @IsString()
  @Length(1, 22)
  statement_descriptor?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(['card', 'upi'], { each: true })
  payment_method_types?: Array<'card' | 'upi'>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class ConfirmPaymentIntentDto {
  @Matches(/^pm_[A-Za-z0-9]+$/, { message: 'payment_method must be a payment method id (pm_...)' })
  payment_method: string;

  @IsOptional()
  @IsString()
  client_secret?: string;
}

export class VerifyOtpDto {
  @Matches(/^\d{4,8}$/, { message: 'otp must be 4-8 digits' })
  otp: string;

  @IsOptional()
  @IsString()
  client_secret?: string;
}

export class CaptureDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_to_capture?: number;
}

export class CancelDto {
  @IsOptional()
  @IsIn(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'])
  cancellation_reason?: string;
}

export class RetrieveQueryDto {
  @IsOptional()
  @IsString()
  client_secret?: string;
}

export class ListPaymentIntentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  starting_after?: string;

  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;
}

export class CreateRefundDto {
  @Matches(/^pi_[A-Za-z0-9]+$/, { message: 'payment_intent must be a payment intent id (pi_...)' })
  payment_intent: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsIn(['duplicate', 'fraudulent', 'requested_by_customer'])
  reason?: string;
}

export class ListRefundsDto {
  @IsOptional()
  @IsString()
  payment_intent?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AnalyticsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class RoutingStrategyDto {
  @IsIn(['smart', 'single'])
  strategy: 'smart' | 'single';
}
