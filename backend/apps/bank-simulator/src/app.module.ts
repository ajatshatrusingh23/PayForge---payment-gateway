import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AcquirerState } from './acquirer-state';
import { migrations } from './migrations';
import { AcquirerController, AdminController } from './simulator.controller';
import { SimulatorService } from './simulator.service';

@Module({
  imports: [CommonModule.forService('bank-simulator'), DatabaseModule.forRoot({ database: 'pf_bank', migrations })],
  controllers: [AcquirerController, AdminController],
  providers: [AcquirerState, SimulatorService],
})
export class AppModule {}
