import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  create(createUserDto: any) {
    return { message: 'User created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }

  update(id: string, updateUserDto: any) {
    return { id, ...updateUserDto };
  }

  remove(id: string) {
    return { id, deleted: true };
  }
}
