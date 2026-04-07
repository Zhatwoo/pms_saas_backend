import { Injectable } from '@nestjs/common';

@Injectable()
export class BranchesService {
  create(createBranchDto: any) {
    return { message: 'Branch created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateBranchDto: any) {
    return { id, ...updateBranchDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
