import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { VPA_PATTERN } from './card';

export class CardDetailsDto {
  @Matches(/^[0-9 ]{12,23}$/, { message: 'card[number] must contain 12-19 digits' })
  number: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  exp_month: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2099)
  exp_year: number;

  @Matches(/^[0-9]{3,4}$/, { message: 'card[cvc] must be 3 or 4 digits' })
  cvc: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;
}

export class UpiDetailsDto {
  @Matches(VPA_PATTERN, { message: 'upi[vpa] must be a valid UPI ID, e.g. name@bank' })
  vpa: string;
}

export class CreatePaymentMethodDto {
  @IsIn(['card', 'upi'])
  type: 'card' | 'upi';

  @ValidateIf((o: CreatePaymentMethodDto) => o.type === 'card')
  @IsDefined({ message: 'card is required when type is card' })
  @ValidateNested()
  @Type(() => CardDetailsDto)
  card?: CardDetailsDto;

  @ValidateIf((o: CreatePaymentMethodDto) => o.type === 'upi')
  @IsDefined({ message: 'upi is required when type is upi' })
  @ValidateNested()
  @Type(() => UpiDetailsDto)
  upi?: UpiDetailsDto;
}

export class RevealDto {
  @IsString()
  @Length(3, 100)
  purpose: string;
}
