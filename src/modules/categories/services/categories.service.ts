import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.categories.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.categories.findUnique({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`Category with ID "${id}" not found`);
    }
    return category;
  }

  async create(dto: CreateCategoryDto) {
    const existing = await this.prisma.categories.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Category name "${dto.name}" already exists`);
    }

    return this.prisma.categories.create({
      data: {
        name: dto.name,
        description: dto.description,
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.findOne(id);

    if (dto.name) {
      const existing = await this.prisma.categories.findFirst({
        where: {
          name: dto.name,
          id: { not: id },
        },
      });
      if (existing) {
        throw new ConflictException(`Category name "${dto.name}" already exists`);
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

  async delete(id: string) {
    await this.findOne(id);
    return this.prisma.categories.delete({
      where: { id },
    });
  }
}
