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
  it('defaults to openai when an API key is present', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TTS_PROVIDER;
    process.env.OPENAI_API_KEY = 'sk-test';
    const tts = await freshModule();
    expect(await tts.resolveProvider()).toBe('openai');
  });

  it('falls back to the free offline engine when no API key is set', async () => {
    // The whole point of the `local` provider: narration must work on a fresh
    // clone and on Railway without anyone buying API credits first.
    process.env.NODE_ENV = 'production';
    delete process.env.TTS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    const tts = await freshModule();
    const engine = await tts.detectLocalEngine();
    if (!engine) return; // no espeak-ng/SAPI on this CI box; nothing to assert
    expect(await tts.resolveProvider()).toBe('local');
    const cfg = await tts.describeConfig();
    expect(cfg.provider).toBe('local');
    expect(cfg.engine).toBe(engine.kind);
    expect(cfg.paid).toBe(false);
  });

  it('reports `local` as not-paid so nobody budgets API money for it', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'local';
    delete process.env.OPENAI_API_KEY;
    const tts = await freshModule();
    if (!(await tts.detectLocalEngine())) return;
    expect((await tts.describeConfig()).paid).toBe(false);
  });

  it('refuses Edge in production unless explicitly accepted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'edge';
    delete process.env.ALLOW_UNLICENSED_TTS;
    const tts = await freshModule();
    await expect(tts.resolveProvider()).rejects.toThrow(/unlicensed/i);
    expect((await tts.describeConfig()).error).toMatch(/ALLOW_UNLICENSED_TTS/);
  });

  it('allows Edge in production when the risk is explicitly accepted', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'edge';
    process.env.ALLOW_UNLICENSED_TTS = 'true';
    const tts = await freshModule();
    expect(await tts.resolveProvider()).toBe('edge');
  });

  it('allows Edge outside production without the extra flag', async () => {
    process.env.NODE_ENV = 'development';
    process.env.TTS_PROVIDER = 'edge';
    delete process.env.ALLOW_UNLICENSED_TTS;
    const tts = await freshModule();
    expect(await tts.resolveProvider()).toBe('edge');
  });

  it('never treats an unknown provider name as Edge', async () => {
    // A typo in TTS_PROVIDER must fail loudly rather than silently resolving to
    // the unlicensed endpoint, or to a paid one.
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'elevenlabs';
    process.env.OPENAI_API_KEY = 'sk-test';
    const tts = await freshModule();
    await expect(tts.resolveProvider()).rejects.toThrow(/Unknown TTS_PROVIDER/);
    await expect(tts.resolveProvider()).rejects.not.toThrow(/^edge$/);
  });

  it('reports an unusable config through describeConfig instead of throwing at require time', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    const tts = await freshModule();
    const cfg = await tts.describeConfig();
    expect(cfg.provider).toBeNull();
    expect(cfg.error).toMatch(/OPENAI_API_KEY/);
  });

  it('exposes a sync preflight so startup does not have to await', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TTS_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    const tts = await freshModule();
    const cfg = tts.describeConfigSync();
    expect(cfg.error).toMatch(/OPENAI_API_KEY/);
    expect(cfg.voices).toHaveLength(4);
  });
});

describe('voice mapping', () => {
  it('maps all four UI voices for every provider', async () => {
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

  it('is case-insensitive and whitespace-tolerant on the provider value', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.TTS_PROVIDER = '  OpenAI  ';
    const tts = await freshModule();
    expect(await tts.resolveProvider()).toBe('openai');
  });

  it('escapes SSML metacharacters so a story cannot forge markup', async () => {
    // A story containing < or & reaches the SAPI SSML document verbatim.
    const tts = await freshModule();
    const escaped = tts.escapeSsml('Boss <level> 3 & "friends" \'all\' went down');
    expect(escaped).not.toMatch(/[<>]/);
    expect(escaped).toContain('&lt;level&gt;');
    expect(escaped).toContain('&amp;');
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('&apos;');
  });
});
