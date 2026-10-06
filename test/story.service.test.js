import { describe, it, expect } from 'vitest';
import { validate, clean } from '../backend/services/story.service';

describe('story.service.validate', () => {
  it('rejects missing / non-string input', () => {
    expect(validate(undefined)).toMatch(/required/);
    expect(validate(null)).toMatch(/required/);
    expect(validate(42)).toMatch(/required/);
    expect(validate({})).toMatch(/required/);
  });

  it('rejects stories under 50 characters', () => {
    expect(validate('too short')).toMatch(/too short/);
  });

  it('rejects stories over 3000 characters', () => {
    expect(validate('x'.repeat(3001))).toMatch(/too long/);
  });

  it('measures length after trimming', () => {
    // 50 real chars surrounded by whitespace must pass.
    const padded = '   ' + 'y'.repeat(50) + '   ';
    expect(validate(padded)).toBeNull();
  });

  it('accepts a valid story', () => {
    expect(validate('z'.repeat(200))).toBeNull();
  });

  it('accepts exactly the boundary lengths', () => {
    expect(validate('a'.repeat(50))).toBeNull();
    expect(validate('a'.repeat(3000))).toBeNull();
  });
});

describe('story.service.clean', () => {
  it('strips markdown that would otherwise be read aloud', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    const raw = '## Heading\n\nThis is **bold** and *italic*.\n\n> a quote';
    const out = await clean(raw);

    expect(out).not.toContain('##');
    expect(out).not.toContain('**');
    expect(out).toContain('bold');
  });

  it('removes URLs', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    const out = await clean('Go to https://example.com/very/long/path now please');
    expect(out).not.toContain('http');
  });

  it('collapses 3+ newlines to a blank line', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    const out = await clean('a\n\n\n\n\nb');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('normalises CRLF to LF', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    const out = await clean('line one\r\nline two');
    expect(out).toBe('line one\nline two');
  });
});
