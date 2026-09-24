import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin } from '../entities/admin.entity';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const walletAddress = user.address || user.walletAddress;
    if (!walletAddress) {
      throw new UnauthorizedException('Wallet address not found in token');
    }

    const admin = await this.adminRepo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), isActive: true },
    });

    if (!admin) {
      throw new ForbiddenException('Admin access required');
    }

    request.admin = admin;
    return true;
  }
}
