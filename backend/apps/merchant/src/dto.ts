import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class SignupDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @Length(8, 128, { message: 'password must be at least 8 characters' })
  password: string;

  @IsString()
  @Length(2, 100)
  business_name: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(1, 128)
  password: string;
}

export class KycDto {
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'pan must be a valid PAN, e.g. ABCDE1234F' })
  pan: string;

  @IsString()
  @Length(2, 100)
  account_holder_name: string;

  @Matches(/^[0-9]{9,18}$/, { message: 'bank_account_number must be 9-18 digits' })
  bank_account_number: string;

  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'ifsc must be a valid IFSC code, e.g. HDFC0001234' })
  ifsc: string;
}

export class AuthenticateKeyDto {
  @IsString()
  @Length(1, 200)
  key: string;
}
