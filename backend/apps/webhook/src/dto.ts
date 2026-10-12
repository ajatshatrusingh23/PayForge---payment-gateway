import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CreateEndpointDto {
  @IsString()
  @Length(8, 2048)
  url: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^(\*|[a-z_]+\.[a-z_.]+)$/, { each: true, message: 'enabled_events must contain event types like payment_intent.captured, or *' })
  enabled_events?: string[];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  description?: string;
}

export class ListDeliveriesDto {
  @IsOptional()
  @IsIn(['pending', 'retrying', 'succeeded', 'dead'])
  status?: string;

  @IsOptional()
  @IsString()
  object_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
