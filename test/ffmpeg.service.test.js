import { describe, it, expect } from 'vitest';
import { escapeFilterPath } from '../backend/services/ffmpeg.service';

// Every character that is structural inside an ffmpeg filtergraph, plus the
// backslash we use to escape it.
const METACHARS = [':', "'", ',', '[', ']'];

/** Walk the output; a backslash consumes the next char. Any metacharacter left
 *  over was emitted unescaped. Simpler and less error-prone than regex. */
function findUnescaped(output, chars) {
  const found = [];
  for (let i = 0; i < output.length; i++) {
    if (output[i] === '\\') { i++; continue; }
    if (chars.includes(output[i])) found.push(output[i]);
  }
  return found;
}

describe('escapeFilterPath', () => {
  it('converts Windows separators to forward slashes', () => {
    expect(escapeFilterPath('C:\\app\\storage\\temp\\job\\captions.ass'))
      .toBe('C' + String.raw`\:` + '/app/storage/temp/job/captions.ass');
  });

  it('leaves an already-POSIX path alone apart from escaping', () => {
    expect(escapeFilterPath('/tmp/captions.ass')).toBe('/tmp/captions.ass');
  });

  it('escapes the drive-letter colon', () => {
    expect(escapeFilterPath('C:/a.ass')).toBe('C' + String.raw`\:` + '/a.ass');
  });

  it('escapes the quote delimiter', () => {
    expect(escapeFilterPath("/tmp/it's.ass")).toBe('/tmp/it' + String.raw`\'` + 's.ass');
  });

  it('escapes commas, which would otherwise split the filter chain', () => {
    expect(escapeFilterPath('/tmp/a,b.ass')).toBe('/tmp/a' + String.raw`\,` + 'b.ass');
  });

  it('escapes bracket label delimiters', () => {
    expect(escapeFilterPath('/tmp/a[0].ass')).toBe('/tmp/a' + String.raw`\[` + '0' + String.raw`\]` + '.ass');
  });

  it('escapes every metacharacter in a hostile path', () => {
    const hostile = String.raw`C:\Users\k\CLIPPER GAME\x,'[1].ass`;
    expect(findUnescaped(escapeFilterPath(hostile), METACHARS)).toEqual([]);
  });

  it('never emits a backslash that does not introduce an escape', () => {
    // Guards against a future edit producing a stray "\" that would swallow
    // the following character when ffmpeg parses the filter chain.
    const out = escapeFilterPath(String.raw`C:\a b,c.ass`);
    const validEscapes = [':', "'", ',', '[', ']'];
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== '\\') continue;
      i++;
      expect(validEscapes).toContain(out[i]);
    }
  });
});
