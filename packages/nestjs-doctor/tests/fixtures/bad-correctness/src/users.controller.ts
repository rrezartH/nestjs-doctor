import { Controller, Get, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get(':id')
  @Get(':id')
  findOne(@Param('userId') userId: string) {
    return { userId };
  }
}
