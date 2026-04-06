import { Injectable } from '@nestjs/common';

@Injectable()
export class ItemsService {
  create(createItemDto: any) {
    return { message: 'Item created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateItemDto: any) {
    return { id, ...updateItemDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
