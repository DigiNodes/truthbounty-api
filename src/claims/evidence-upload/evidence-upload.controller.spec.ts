import { Test, TestingModule } from '@nestjs/testing';
import { EvidenceUploadController } from './evidence-upload.controller';
import { EvidenceUploadPreparationService } from './evidence-upload-preparation.service';

describe('EvidenceUploadController (PREWAVE-BE-132)', () => {
  let controller: EvidenceUploadController;
  let preparation: { prepare: jest.Mock };

  beforeEach(async () => {
    preparation = {
      prepare: jest.fn().mockResolvedValue({ canonical: false }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EvidenceUploadController],
      providers: [
        { provide: EvidenceUploadPreparationService, useValue: preparation },
      ],
    }).compile();
    controller = module.get(EvidenceUploadController);
  });

  it('delegates to the non-authoritative preparation service', async () => {
    const dto = { content: 'body' };
    await expect(controller.prepareUpload('claim-1', dto)).resolves.toEqual({
      canonical: false,
    });
    expect(preparation.prepare).toHaveBeenCalledWith('claim-1', dto);
  });
});
