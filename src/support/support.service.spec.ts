import { SupportRequestService } from './support.service';

describe('SupportRequestService', () => {
  let service: SupportRequestService;

  beforeEach(() => {
    service = new SupportRequestService();
  });

  const supportStaff = { user: { id: 'staff-1', role: 'admin' } };

  it('accepts a minimal safe support request', () => {
    const result = service.createSupportRequest({
      category: 'bug',
      contact: 'user@example.com',
      description: 'The app crashes after I submit evidence for a claim.',
      release: 'v1.2.3',
      diagnostics: ['requestId: abc123', 'release: v1.2.3'],
    });

    expect(result.status).toBe('submitted');
    expect(result.duplicate).toBe(false);
    expect(result.reference).toBeTruthy();
    expect(result).not.toHaveProperty('contact');
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('diagnostics');
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
    expect(second).not.toHaveProperty('contact');
    expect(second).not.toHaveProperty('description');
  });

  it('expires stale entries according to the retention window', () => {
    service.createSupportRequest({
      category: 'question',
      contact: 'user@example.com',
      description: 'Requesting a policy clarification for the moderation queue.',
      release: 'v1.2.3',
    });
    const [oldRequest] = service.listSupportRequests(supportStaff);

    oldRequest.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    oldRequest.expiresAt = new Date(Date.now() - 1000).toISOString();

    const expired = service.cleanupExpiredSupportRequests();
    expect(expired).toContain(oldRequest.id);
  });

  it('requires moderator or admin authorization at the service boundary', () => {
    expect(() => service.listSupportRequests(undefined)).toThrow(
      'Support staff access required',
    );
    expect(() =>
      service.getSupportRequest('arbitrary-id', {
        user: { role: 'contributor' },
      }),
    ).toThrow('Support staff access required');
    expect(() =>
      service.deleteSupportRequest('arbitrary-id', {
        user: { role: 'contributor' },
      }),
    ).toThrow('Support staff access required');
  });

  it('allows authorized staff to retrieve and delete retained requests', () => {
    service.createSupportRequest({
      category: 'bug',
      contact: 'user@example.com',
      description: 'The application fails while opening my account page.',
    });
    const [record] = service.listSupportRequests(supportStaff);

    expect(service.getSupportRequest(record.id, supportStaff)).toEqual(record);
    expect(service.deleteSupportRequest(record.id, supportStaff)).toBe(true);
    expect(service.getSupportRequest(record.id, supportStaff)).toBeUndefined();
  });
});
