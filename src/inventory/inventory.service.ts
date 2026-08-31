import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryItem } from '../entities/inventory-item.entity';
import { Item } from '../entities/item.entity';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly inventoryRepository: Repository<InventoryItem>,
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
  ) {}

  async equipItem(userId: string, itemId: string) {
    const inventoryItem = await this.inventoryRepository.findOne({
      where: { user: { id: userId }, item: { id: itemId } },
    });

    if (!inventoryItem) {
      throw new NotFoundException('Item not found in inventory');
    }

    inventoryItem.isEquipped = true;
    return this.inventoryRepository.save(inventoryItem);
  }

  async unequipItem(userId: string, itemId: string) {
    const inventoryItem = await this.inventoryRepository.findOne({
      where: { user: { id: userId }, item: { id: itemId } },
    });

    if (!inventoryItem) {
      throw new NotFoundException('Item not found in inventory');
    }

    inventoryItem.isEquipped = false;
    return this.inventoryRepository.save(inventoryItem);
  }

  async getInventory(userId: string) {
    return this.inventoryRepository.find({
      where: { user: { id: userId } },
      relations: ['item'],
    });
  }
}
