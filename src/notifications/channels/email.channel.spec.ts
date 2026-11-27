import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EmailChannel } from './email.channel';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { UnsubscribeTokenService } from '../services/unsubscribe-token.service';

describe('EmailChannel HTML document', () => {
  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'JWT_SECRET' || key === 'UNSUBSCRIBE_TOKEN_SECRET') {
        return 'test-secret-with-at-least-32-characters-needed!!';
      }
      return defaultValue;
    }),
  } as unknown as ConfigService;

  const channel = new EmailChannel(
    {} as HttpService,
    mockConfigService,
    {} as PreferenceEnforcer,
  );
  const build = (body: string, actionUrl?: string, unsubscribeToken?: string): string =>
    (
      channel as unknown as {
        buildHtmlEmail(body: string, actionUrl?: string, unsubscribeToken?: string): string;
      }
    ).buildHtmlEmail(body, actionUrl, unsubscribeToken);

  it('keeps the rendered template body markup intact', () => {
    expect(
      build('<p><strong>Claim:</strong> &lt;b&gt;x&lt;/b&gt;</p>'),
    ).toContain('<p><strong>Claim:</strong> &lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('renders the call to action for a safe URL with the attribute escaped', () => {
    expect(
      build('body', 'https://truthbounty.io/claims?id=1&tab="x"'),
    ).toContain(
      '<a href="https://truthbounty.io/claims?id=1&amp;tab=&quot;x&quot;" class="cta-button">View More</a>',
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.test',
  ])('omits the call to action for unsafe URL %p', (url) => {
    const html = build('body', url);

    expect(html).not.toContain('cta-button">View More');
    expect(html).not.toContain(url);
  });

  describe('Unsubscribe token generation and embedding (PREWAVE-BE-199 / #798)', () => {
    it('generates an opaque token that never exposes the userId or Date.now() timestamp', () => {
      const userId = 'user-secret-id-9988';
      const token = (channel as unknown as { generateUnsubscribeToken(id: string): string }).generateUnsubscribeToken(userId);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.startsWith('tbunsub_')).toBe(true);
      expect(token).not.toContain(userId);
      expect(token).not.toContain(`${userId}-`);
      expect(token).not.toMatch(new RegExp(`^${userId}-\\d+$`));
    });

    it('renders the unsubscribe link in email HTML with safe token', () => {
      const token = 'tbunsub_safeOpaqueTokenValue123456789012345678';
      const html = build('Hello body', undefined, token);

      expect(html).toContain(
        '<a href="https://truthbounty.io/unsubscribe/tbunsub_safeOpaqueTokenValue123456789012345678" class="unsubscribe-link">Unsubscribe</a>',
      );
    });

    it('delegates to injected UnsubscribeTokenService when provided', () => {
      const mockUnsubscribeService = {
        generateToken: jest.fn().mockReturnValue('tbunsub_mocked_token_xyz'),
      } as unknown as UnsubscribeTokenService;

      const customChannel = new EmailChannel(
        {} as HttpService,
        mockConfigService,
        {} as PreferenceEnforcer,
        undefined,
        mockUnsubscribeService,
      );

      const token = (customChannel as unknown as { generateUnsubscribeToken(id: string): string }).generateUnsubscribeToken('user-42');
      expect(token).toBe('tbunsub_mocked_token_xyz');
      expect(mockUnsubscribeService.generateToken).toHaveBeenCalledWith({
        userId: 'user-42',
        channel: 'EMAIL',
      });
    });
  });
});
