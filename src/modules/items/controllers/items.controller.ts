import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { ItemsService } from '../services/items.service';
import { Roles } from '../../../common/decorators';
import { Role } from '../../../common/enums';

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Post()
  create(@Body() createItemDto: any) {
    return this.itemsService.create(createItemDto);
  }

  @Get()
  findAll() {
    return this.itemsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.itemsService.findOne(id);
  }

  @Roles(Role.ADMIN, Role.EMPLOYEE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateItemDto: any) {
    return this.itemsService.update(id, updateItemDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.itemsService.remove(id);
  }
}
