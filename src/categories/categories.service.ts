import { Injectable } from '@nestjs/common';

@Injectable()
export class CategoriesService {
  create(createCategoryDto: any) {
    return { message: 'Category created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateCategoryDto: any) {
    return { id, ...updateCategoryDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
