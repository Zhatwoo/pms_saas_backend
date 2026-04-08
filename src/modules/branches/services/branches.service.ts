import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class BranchesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private normalizeBranchName(rawName: string): string {
    const trimmed = rawName.trim();
    const withoutSuffix = trimmed.replace(/\s*branch\s*$/i, '');
    const normalizedBase = this.toTitleCase(withoutSuffix);
    return `${normalizedBase} Branch`;
  }

  async create(createBranchDto: CreateBranchDto) {
    const payload: CreateBranchDto = {
      ...createBranchDto,
      name: this.normalizeBranchName(createBranchDto.name),
    };

    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .insert([payload])
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async findAll() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async update(id: string, updateBranchDto: UpdateBranchDto) {
    const payload: UpdateBranchDto = {
      ...updateBranchDto,
      ...(updateBranchDto.name
        ? { name: this.normalizeBranchName(updateBranchDto.name) }
        : {}),
    };

    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('branches')
      .delete()
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { deleted: true };
  }
}

