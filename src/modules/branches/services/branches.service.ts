import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CreateBranchDto } from '../dto/create-branch.dto';
import { UpdateBranchDto } from '../dto/update-branch.dto';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';

@Injectable()
export class BranchesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async create(createBranchDto: CreateBranchDto) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .insert([createBranchDto])
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
    const { data, error } = await this.supabaseService
      .getClient()
      .from('branches')
      .update(updateBranchDto)
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

