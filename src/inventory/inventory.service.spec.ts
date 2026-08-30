import { Test, TestingModule } from '@nestjs/testing';
import { InventoryService } from './inventory.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InventoryItem } from '../entities/inventory-item.entity';
import { Item } from '../entities/item.entity';

describe('InventoryService', () => {
  let service: InventoryService;
  let inventoryRepository: any;

  beforeEach(async () => {
    const mockInventoryRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
    };
    const mockItemRepository = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: getRepositoryToken(InventoryItem), useValue: mockInventoryRepository },
        { provide: getRepositoryToken(Item), useValue: mockItemRepository },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
    inventoryRepository = module.get(getRepositoryToken(InventoryItem));
  });

  it('should equip an item', async () => {
    const mockItem = { id: 'item-1', isEquipped: false };
    inventoryRepository.findOne.mockResolvedValue(mockItem);
    inventoryRepository.save.mockResolvedValue({ ...mockItem, isEquipped: true });

    const result = await service.equipItem('user-1', 'item-1');
    expect(result.isEquipped).toBe(true);
  });

  it('should unequip an item', async () => {
    const mockItem = { id: 'item-1', isEquipped: true };
    inventoryRepository.findOne.mockResolvedValue(mockItem);
    inventoryRepository.save.mockResolvedValue({ ...mockItem, isEquipped: false });

    const result = await service.unequipItem('user-1', 'item-1');
    expect(result.isEquipped).toBe(false);
  });
});
