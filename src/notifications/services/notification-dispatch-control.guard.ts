import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OperationalControl } from '../../admin/entities/operational-control.entity';
import {
  isNotificationsEnabled,
  CONTROL_ID,
} from '../../admin/protocol/operational-control-state';

@Injectable()
export class NotificationDispatchControlGuard {
  constructor(
    @InjectRepository(OperationalControl)
    private readonly controlRepo: Repository<OperationalControl>,
  ) {}

  async isNotificationsEnabled(): Promise<boolean> {
    const control: OperationalControl | null = await this.controlRepo.findOne({
      where: { id: CONTROL_ID },
    });
    return control ? isNotificationsEnabled(control, Date.now()) : false;
  }
}
