import { Injectable } from '@nestjs/common';

@Injectable()
export class ItemsService {
  create(_createItemDto: Record<string, unknown>) {
    return { message: 'Item created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateItemDto: Record<string, unknown>) {
    return { id, ...updateItemDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
