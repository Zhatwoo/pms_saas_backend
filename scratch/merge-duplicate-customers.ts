import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/infrastructure/supabase/supabase.service';
import { CustomersService } from '../src/modules/customers/services/customers.service';
import { Role } from '../src/common/enums';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() : '';
}

async function main() {
  const branchId = readArg('branchId');
  if (!branchId) {
    throw new Error('Missing --branchId=<uuid>');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const supabase = app.get(SupabaseService);
    const customersService = app.get(CustomersService);
    const client = supabase.getClient();

    const { data: superAdmin, error: superAdminError } = await client
      .from('users')
      .select('id, full_name, email, role, branch_id')
      .in('role', ['super_admin', 'superadmin'])
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (superAdminError) {
      throw new Error(superAdminError.message);
    }

    if (!superAdmin) {
      throw new Error('No super admin user found in public.users');
    }

    const result = await customersService.mergeDuplicateCustomers(
      {
        id: superAdmin.id,
        authId: superAdmin.id,
        fullName: superAdmin.full_name,
        email: superAdmin.email,
        role: Role.SUPER_ADMIN,
        branchId: null,
        branchName: null,
        avatarUrl: null,
      } as any,
      branchId,
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});