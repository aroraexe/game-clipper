import { describe, it, expect, afterEach } from 'vitest';

const ENV_KEYS = ['NODE_ENV', 'TTS_PROVIDER', 'ALLOW_UNLICENSED_TTS', 'OPENAI_API_KEY'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

// tts.service reads env inside resolveProvider(), so it can be re-imported per case.
async function freshModule() {
  const id = `../backend/services/tts.service.js?t=${Math.random()}`;
  return import(id);
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('TTS provider policy', () => {
  it('defaults to openai, not the unlicensed Edge endpoint', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TTS_PROVIDER;
    process.env.OPENAI_API_KEY = 'sk-test';
    const tts = await freshModule();
    expect(tts.resolveProvider()).toBe('openai');
  });

  it('refuses Edge in production unless explicitly accepted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'edge';
    delete process.env.ALLOW_UNLICENSED_TTS;
    const tts = await freshModule();
    expect(() => tts.resolveProvider()).toThrow(/unlicensed/i);
    expect(tts.describeConfig().error).toMatch(/ALLOW_UNLICENSED_TTS/);
  });

  it('allows Edge in production when the risk is explicitly accepted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'edge';
    process.env.ALLOW_UNLICENSED_TTS = 'true';
    const tts = await freshModule();
    expect(tts.resolveProvider()).toBe('edge');
  });

  it('allows Edge outside production without the extra flag', async () => {
    process.env.NODE_ENV = 'development';
    process.env.TTS_PROVIDER = 'edge';
    delete process.env.ALLOW_UNLICENSED_TTS;
    const tts = await freshModule();
    expect(tts.resolveProvider()).toBe('edge');
  });

  it('never treats an unknown provider name as Edge', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'elevenlabs';
    process.env.OPENAI_API_KEY = 'sk-test';
    const tts = await freshModule();
    expect(tts.resolveProvider()).toBe('openai');
  });
});

describe('voice mapping', () => {
  it('maps all four UI voices for both providers', async () => {
    const tts = await freshModule();
    expect(Object.keys(tts.VOICES).sort()).toEqual(['calm', 'default', 'energetic', 'narrator']);
    for (const v of Object.keys(tts.VOICES)) {
      expect(tts.VOICES[v].openai).toBeTruthy();
      expect(tts.VOICES[v].edge).toBeTruthy();
    }
  });

  it('gives each UI voice a DISTINCT id per provider', async () => {
    // Regression guard: the Edge path used to ignore the requested voice and
    // hardcode one id, so Calm / Energetic / Narrator all sounded identical.
    const tts = await freshModule();
    const names = Object.keys(tts.VOICES);
    const openaiIds = names.map((n) => tts.VOICES[n].openai);
    const edgeIds   = names.map((n) => tts.VOICES[n].edge);
    expect(new Set(openaiIds).size).toBe(names.length);
    expect(new Set(edgeIds).size).toBe(names.length);
  });

  it('is case-insensitive on the provider value', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.TTS_PROVIDER = '  OpenAI  ';
    const tts = await freshModule();
    expect(tts.resolveProvider()).toBe('openai');
  });
});
