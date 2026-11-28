import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EmailChannel } from './email.channel';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';

describe('EmailChannel HTML document', () => {
  const channel = new EmailChannel(
    {} as HttpService,
    { get: jest.fn() } as unknown as ConfigService,
    {} as PreferenceEnforcer,
  );
  const build = (body: string, actionUrl?: string): string =>
    (
      channel as unknown as {
        buildHtmlEmail(body: string, actionUrl?: string): string;
      }
    ).buildHtmlEmail(body, actionUrl);

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
});
