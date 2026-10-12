import { IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class AssessDto {
  @IsString()
  merchant_id: string;

  @IsString()
  payment_intent_id: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  currency: string;

  @IsIn(['card', 'upi'])
  payment_method_type: 'card' | 'upi';

  @IsString()
  fingerprint: string;

  @IsOptional()
  @IsString()
  card_country?: string;

  @IsOptional()
  @IsString()
  vpa?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  ip?: string;
}

export const BLOCKLIST_TYPES = ['fingerprint', 'email', 'ip', 'vpa'] as const;

export class CreateBlocklistDto {
  @IsIn(BLOCKLIST_TYPES)
  type: (typeof BLOCKLIST_TYPES)[number];

  @IsString()
  @Length(1, 320)
  value: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  reason?: string;
}
