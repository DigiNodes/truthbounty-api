import { SupportRequestService } from './support.service';

describe('SupportRequestService', () => {
  let service: SupportRequestService;

  beforeEach(() => {
    service = new SupportRequestService();
  });

  it('accepts a minimal safe support request', () => {
    const result = service.createSupportRequest({
      category: 'bug',
      contact: 'user@example.com',
      description: 'The app crashes after I submit evidence for a claim.',
      release: 'v1.2.3',
      diagnostics: ['requestId: abc123', 'release: v1.2.3'],
    });

    expect(result.id).toBeTruthy();
    expect(result.status).toBe('submitted');
    expect(result.duplicate).toBe(false);
    expect(result.expiresAt).toBeTruthy();
    expect(result.retentionDays).toBe(30);
  });

  it('rejects likely secrets and private key material before persistence', () => {
    expect(() =>
      service.createSupportRequest({
        category: 'bug',
        contact: 'user@example.com',
        description: 'My wallet private key is 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        release: 'v1.2.3',
      }),
    ).toThrow(/private key|secret|sensitive/i);
  });

  it('deduplicates identical support submissions and returns the original reference', () => {
    const dto = {
      category: 'bug',
      contact: 'user@example.com',
      description: 'The app crashes after I submit evidence for a claim.',
      release: 'v1.2.3',
      diagnostics: ['requestId: abc123'],
    };

    const first = service.createSupportRequest(dto);
    const second = service.createSupportRequest(dto);

    expect(second.duplicate).toBe(true);
    expect(second.reference).toBe(first.reference);
  });

  it('expires stale entries according to the retention window', () => {
    const oldRequest = service.createSupportRequest({
      category: 'question',
      contact: 'user@example.com',
      description: 'Requesting a policy clarification for the moderation queue.',
      release: 'v1.2.3',
    });

    oldRequest.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    oldRequest.expiresAt = new Date(Date.now() - 1000).toISOString();

    const expired = service.cleanupExpiredSupportRequests();
    expect(expired).toContain(oldRequest.id);
  });

  describe('deleteSupportRequest', () => {
    it('hard-deletes a non-expired request and leaves unrelated active requests unchanged', () => {
      const target = service.createSupportRequest({
        category: 'bug',
        contact: 'target@example.com',
        description: 'Target request to be deleted for privacy erasure.',
        release: 'v1.2.3',
      });
      const unrelated = service.createSupportRequest({
        category: 'question',
        contact: 'other@example.com',
        description: 'Unrelated active request that must remain intact.',
        release: 'v1.2.3',
      });

      const result = service.deleteSupportRequest(target.id);

      expect(result).toEqual({
        deleted: true,
        id: target.id,
        reference: target.reference,
      });
      expect(service.getSupportRequest(target.id)).toBeUndefined();
      expect(service.getSupportRequest(unrelated.id)).toEqual(unrelated);
      expect(service.listSupportRequests()).toEqual([unrelated]);
    });

    it('removes the associated fingerprint so a later legitimate request is not treated as a duplicate', () => {
      const dto = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'The app crashes after I submit evidence for a claim.',
        release: 'v1.2.3',
        diagnostics: ['requestId: abc123'],
      };

      const first = service.createSupportRequest(dto);
      const deleted = service.deleteSupportRequest(first.id);
      expect(deleted.deleted).toBe(true);

      const resubmitted = service.createSupportRequest(dto);
      expect(resubmitted.duplicate).toBe(false);
      expect(resubmitted.status).toBe('submitted');
      expect(resubmitted.id).not.toBe(first.id);
    });

    it('keeps expired cleanup separate from targeted deletion', () => {
      const active = service.createSupportRequest({
        category: 'bug',
        contact: 'active@example.com',
        description: 'Active request targeted for deletion.',
        release: 'v1.2.3',
      });
      const expired = service.createSupportRequest({
        category: 'question',
        contact: 'expired@example.com',
        description: 'Expired request that should only be removed by retention cleanup.',
        release: 'v1.2.3',
      });
      expired.expiresAt = new Date(Date.now() - 1000).toISOString();

      const cleanupSpy = jest.spyOn(service, 'cleanupExpiredSupportRequests');

      const result = service.deleteSupportRequest(active.id);

      expect(result).toEqual({
        deleted: true,
        id: active.id,
        reference: active.reference,
      });
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(service.getSupportRequest(expired.id)).toEqual(expired);
    });

    it('returns truthful not-found results for missing and already-deleted IDs', () => {
      expect(service.deleteSupportRequest('non-existent-id')).toEqual({
        deleted: false,
        id: 'non-existent-id',
      });

      const created = service.createSupportRequest({
        category: 'bug',
        contact: 'user@example.com',
        description: 'Request that will be deleted twice.',
        release: 'v1.2.3',
      });

      expect(service.deleteSupportRequest(created.id)).toEqual({
        deleted: true,
        id: created.id,
        reference: created.reference,
      });
      expect(service.deleteSupportRequest(created.id)).toEqual({
        deleted: false,
        id: created.id,
      });
    });

    it('never returns deleted: true when the underlying store delete fails', () => {
      const created = service.createSupportRequest({
        category: 'bug',
        contact: 'user@example.com',
        description: 'Request whose underlying delete fails.',
        release: 'v1.2.3',
      });

      const internalRequests = (service as unknown as {
        requests: Map<string, unknown>;
      }).requests;

      jest.spyOn(internalRequests, 'delete').mockReturnValueOnce(false);
      expect(service.deleteSupportRequest(created.id)).toEqual({
        deleted: false,
        id: created.id,
      });

      jest.spyOn(internalRequests, 'delete').mockImplementationOnce(() => {
        throw new Error('store delete failed');
      });
      expect(() => service.deleteSupportRequest(created.id)).toThrow(
        'store delete failed',
      );
      expect(service.getSupportRequest(created.id)).toEqual(created);
    });
  });
});
