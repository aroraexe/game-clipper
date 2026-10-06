import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generate, hexToAssColor, toAssTime, PRESETS } from '../backend/services/subtitle.service';

let tmpDir;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-test-')); });
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const WORDS = [
  { word: 'Hello',  start: 0.0,  end: 0.5 },
  { word: 'there',  start: 0.5,  end: 1.0 },
  { word: 'friend', start: 1.0,  end: 1.6 },
  { word: 'again',  start: 1.6,  end: 2.2 },
];

describe('toAssTime', () => {
  it('formats sub-minute times', () => {
    expect(toAssTime(0)).toBe('0:00:00.00');
    expect(toAssTime(1.5)).toBe('0:00:01.50');
    expect(toAssTime(61.25)).toBe('0:01:01.25');
  });

  it('formats hours', () => {
    expect(toAssTime(3661)).toBe('1:01:01.00');
  });
});

describe('hexToAssColor', () => {
  it('converts #RRGGBB to ASS AABBGGRR (note the reversed order)', () => {
    // red -> blue channel ends up first
    expect(hexToAssColor('#FF0000')).toBe('&H000000FF');
    expect(hexToAssColor('#00FF00')).toBe('&H0000FF00');
    expect(hexToAssColor('#0000FF')).toBe('&H00FF0000');
    expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF');
  });

  it('returns null for invalid input instead of producing garbage', () => {
    expect(hexToAssColor(null)).toBeNull();
    expect(hexToAssColor('')).toBeNull();
    expect(hexToAssColor('#FFF')).toBeNull();          // too short
    expect(hexToAssColor('red')).toBeNull();
    expect(hexToAssColor('#GGGGGG')).toBeNull();
    expect(hexToAssColor('rgb(1,2,3)')).toBeNull();
  });
});

describe('generate', () => {
  it('throws on empty word list', () => {
    expect(() => generate([], path.join(tmpDir, 'x.ass'))).toThrow(/No word timestamps/);
    expect(() => generate(null, path.join(tmpDir, 'x.ass'))).toThrow(/No word timestamps/);
  });

  it('writes a well-formed ASS file', () => {
    const out = path.join(tmpDir, 'basic.ass');
    generate(WORDS, out, 'bold-yellow');
    const content = fs.readFileSync(out, 'utf8');

    expect(content).toContain('[Script Info]');
    expect(content).toContain('[V4+ Styles]');
    expect(content).toContain('[Events]');
    expect(content).toContain('Format: Layer, Start, End, Style');
    expect(content).toContain('Dialogue:');
  });

  it('uses the PlayRes matching the configured output resolution', () => {
    const out = path.join(tmpDir, 'res.ass');
    generate(WORDS, out);
    const content = fs.readFileSync(out, 'utf8');
    expect(content).toMatch(/PlayResX: 720/);
    expect(content).toMatch(/PlayResY: 1280/);
  });

  it('groups words into chunks of wordsPerLine', () => {
    const out = path.join(tmpDir, 'chunk.ass');
    generate(WORDS, out, 'bold-yellow'); // wordsPerLine: 3
    const dialogueLines = fs.readFileSync(out, 'utf8')
      .split('\n').filter(l => l.startsWith('Dialogue:'));

    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain('Hello there friend');
    expect(dialogueLines[1]).toContain('again');
  });

  it('emits one dialogue line per word for word-pop', () => {
    const out = path.join(tmpDir, 'pop.ass');
    generate(WORDS, out, 'word-pop');
    const dialogueLines = fs.readFileSync(out, 'utf8')
      .split('\n').filter(l => l.startsWith('Dialogue:'));

    expect(dialogueLines).toHaveLength(WORDS.length);
    expect(fs.readFileSync(out, 'utf8')).toContain('\\fscx120');
  });

  it('emits karaoke highlight lines for white-highlight', () => {
    const out = path.join(tmpDir, 'hl.ass');
    generate(WORDS, out, 'white-highlight');
    const content = fs.readFileSync(out, 'utf8');

    expect(content).toContain('{\\rHighlight}');
    expect(content).toContain('{\\rDefault}');
  });

  it('applies a valid custom colour and ignores an invalid one', () => {
    const validOut = path.join(tmpDir, 'colour-ok.ass');
    generate(WORDS, validOut, 'bold-yellow', '#FF0000');
    expect(fs.readFileSync(validOut, 'utf8')).toContain('&H000000FF');

    const badOut = path.join(tmpDir, 'colour-bad.ass');
    generate(WORDS, badOut, 'bold-yellow', 'javascript:alert(1)');
    // Falls back to the preset default rather than writing the injection.
    expect(fs.readFileSync(badOut, 'utf8')).toContain(PRESETS['bold-yellow'].primaryColor);
  });

  it('falls back to the default preset for an unknown style', () => {
    const out = path.join(tmpDir, 'unknown.ass');
    generate(WORDS, out, 'does-not-exist');
    expect(fs.readFileSync(out, 'utf8')).toContain('StoryPlay Subtitles');
  });

  it('does not mutate the shared PRESETS object', () => {
    const before = PRESETS['bold-yellow'].primaryColor;
    generate(WORDS, path.join(tmpDir, 'mutate.ass'), 'bold-yellow', '#123456');
    expect(PRESETS['bold-yellow'].primaryColor).toBe(before);
  });
});
