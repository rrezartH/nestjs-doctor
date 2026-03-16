import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [
    {
      provide: 'CONFIG',
      useFactory: (a) => ({ key: a }),
      inject: ['A', 'B'],
    },
  ],
})
export class AppModule {}
