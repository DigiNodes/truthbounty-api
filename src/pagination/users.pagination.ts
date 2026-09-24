// users.pagination.ts

import { Controller, Get, Query, Injectable } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

// ----------------------
// 📦 Pagination DTO
// ----------------------
class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}

// ----------------------
// 🧠 Service (inline)
// ----------------------
@Injectable()
class UsersService {
  // Replace with your actual repository
  private users = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    createdAt: new Date(),
  }));

  async getUsers({ page, limit }: PaginationDto) {
    const skip = (page - 1) * limit;

    const data = this.users.slice(skip, skip + limit);
    const total = this.users.length;

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}

// ----------------------
// 🚀 Controller
// ----------------------
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  async getUsers(@Query() paginationDto: PaginationDto) {
    return this.usersService.getUsers(paginationDto);
  }
}