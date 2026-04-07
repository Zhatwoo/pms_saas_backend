import { Injectable } from '@nestjs/common';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';

@Injectable()
export class BranchesService {
  create(createBranchDto: CreateBranchDto) {
    return { message: 'Branch created', ...createBranchDto };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateBranchDto: UpdateBranchDto) {
    return { id, ...updateBranchDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
