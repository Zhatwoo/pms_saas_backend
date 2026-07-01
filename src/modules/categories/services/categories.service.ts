import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  environmentCreateFields,
  getEnvironment,
} from '../../../common/utils/authorization.util';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(user: AuthenticatedUserProfile) {
    return this.prisma.categories.findMany({
      where: { environment: getEnvironment(user) },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(user: AuthenticatedUserProfile, id: string) {
    const category = await this.prisma.categories.findFirst({
      where: { id, environment: getEnvironment(user) },
    });
    if (!category) {
      throw new NotFoundException(`Category with ID "${id}" not found`);
    }
    return category;
  }

  async create(user: AuthenticatedUserProfile, dto: CreateCategoryDto) {
    const environment = getEnvironment(user);
    const existing = await this.prisma.categories.findFirst({
      where: { name: dto.name, environment },
    });
    if (existing) {
      throw new ConflictException(`Category name "${dto.name}" already exists`);
    }

    return this.prisma.categories.create({
      data: {
        name: dto.name,
        description: dto.description,
        ...environmentCreateFields(user),
      },
    });
  }

  async update(
    user: AuthenticatedUserProfile,
    id: string,
    dto: UpdateCategoryDto,
  ) {
    const environment = getEnvironment(user);
    await this.findOne(user, id);

    if (dto.name) {
      const existing = await this.prisma.categories.findFirst({
        where: {
          name: dto.name,
          environment,
          id: { not: id },
        },
      });
      if (existing) {
        throw new ConflictException(
          `Category name "${dto.name}" already exists`,
        );
      }
    }

    return this.prisma.categories.update({
      where: { id },
      data: {
        ...dto,
        updated_at: new Date(),
      },
    });
  }

  async delete(user: AuthenticatedUserProfile, id: string) {
    await this.findOne(user, id);
    return this.prisma.categories.delete({
      where: { id },
    });
  }
}
