import { Injectable } from '@nestjs/common';

@Injectable()
export class TransactionsService {
  create(createTransactionDto: any) {
    return { message: 'Transaction created' };
  }

  findAll() {
    return [];
  }

  findOne(id: string) {
    return { id };
  }
}
