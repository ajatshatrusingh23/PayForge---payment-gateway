import { DynamicModule, Module } from '@nestjs/common';
import { Db, DB_OPTIONS, DbOptions } from './db';

@Module({})
export class DatabaseModule {
  static forRoot(options: DbOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: DB_OPTIONS, useValue: options }, Db],
      exports: [Db],
    };
  }
}
