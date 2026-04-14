import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private supabaseService: SupabaseService) {}

  private isActiveBranchStatus(status: string | null | undefined): boolean {
    return status?.trim().toLowerCase() === 'active';
  }

  async register(registerDto: RegisterDto) {
    try {
      return await this.registerInternal(registerDto);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`register failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      throw new InternalServerErrorException(
        msg?.trim() ? msg : 'Registration failed',
      );
    }
  }

  private async registerInternal(registerDto: RegisterDto) {
    const client = this.supabaseService.getClient();
    const email = registerDto.email.trim().toLowerCase();
    const fullName = registerDto.fullName.trim();
    const normalizedRole = registerDto.role === 'admin' ? 'admin' : 'employee';

    const { data: branches, error: branchError } = await client
      .from('branches')
      .select('id, status')
      .eq('id', registerDto.branchId);

    const branch = branches?.[0];

    if (
      branchError ||
      !branch ||
      !this.isActiveBranchStatus(branch.status)
    ) {
      throw new BadRequestException('Invalid or inactive branch');
    }

    const { data: authData, error: authError } =
      await client.auth.admin.createUser({
        email,
        password: registerDto.password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
        app_metadata: {
          role: normalizedRole,
          branch_id: registerDto.branchId,
        },
      });

    if (authError || !authData.user) {
      const msg = authError?.message ?? 'Failed to create account';
      if (/already|registered|exists/i.test(msg)) {
        throw new ConflictException('Email already registered');
      }
      throw new BadRequestException(msg);
    }

    const authId = authData.user.id;

    const row = {
      auth_id: authId,
      email,
      full_name: fullName,
      role: normalizedRole,
      branch_id: registerDto.branchId,
      account_status: 'pending' as const,
    };

    // Upsert: DB triggers (or prior inserts) may already create a users row for new auth users.
    const { error: upsertError } = await client.from('users').upsert(row, {
      onConflict: 'auth_id',
    });

    if (upsertError) {
      await client.auth.admin.deleteUser(authId);
      const detail = [
        upsertError.message,
        upsertError.code ? `code=${upsertError.code}` : '',
        (upsertError as { details?: string }).details
          ? String((upsertError as { details?: string }).details)
          : '',
        (upsertError as { hint?: string }).hint
          ? `hint=${(upsertError as { hint?: string }).hint}`
          : '',
      ]
        .filter(Boolean)
        .join(' | ');
      throw new InternalServerErrorException(
        detail || 'Failed to save user profile',
      );
    }

    return {
      message:
        'Registration submitted. A Super Admin must approve your account before you can sign in.',
    };
  }

  async login(loginDto: LoginDto) {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginDto.email,
      password: loginDto.password,
    });

    if (error) {
      throw new UnauthorizedException(error.message);
    }

    const user = await this.supabaseService.assertSessionUserByAuthId(
      data.user.id,
    );

    return {
      access_token: data.session.access_token,
      expires_in: data.session.expires_in,
      user: {
        id: user.id,
        authId: user.authId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        branchId: user.branchId,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.supabaseService.assertSessionUserById(userId);

    return {
      id: user.id,
      authId: user.authId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      branchId: user.branchId,
      avatarUrl: user.avatarUrl,
    };
  }

  async verifyPassword(authId: string, email: string, password: string) {
    const supabase = this.supabaseService.getClient();

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.warn(`Password verification failed for ${email}: ${error.message}`);
      return false;
    }

    return true;
  }
}
