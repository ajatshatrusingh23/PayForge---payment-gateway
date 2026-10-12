import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { migrations } from './migrations';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';

@Module({
  imports: [CommonModule.forService('vault'), DatabaseModule.forRoot({ database: 'pf_vault', migrations })],
  controllers: [VaultController],
  providers: [VaultService],
})
export class AppModule {}
