import { Injectable } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  async login(loginDto: LoginDto) {
    // TODO: validate credentials, return JWT
    return { message: 'Login endpoint — implement JWT strategy' };
  }
}
