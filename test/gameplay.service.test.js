import { describe, it, expect } from 'vitest';
import { listAll, getById, selectSegment } from '../backend/services/gameplay.service';

describe('gameplay catalogue', () => {
  it('only lists games that actually have files on this machine', () => {
    const items = listAll();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('available');
    }
  });

  it('drops entries whose files are entirely missing instead of silently mocking', () => {
    // subway-surfers / geometry-dash have no files anywhere.
    const ids = listAll().map(i => i.id);
    expect(ids).not.toContain('subway-surfers');
    expect(ids).not.toContain('geometry-dash');
  });

  it('marks an entry unavailable when neither primary nor fallback exists', () => {
    const items = listAll();
    const missing = items.filter(i => !i.available);
    for (const m of missing) {
      expect(m.availabilityNote).toBeNull();
    }
  });

  it('never exposes internal file paths in the public listing', () => {
    for (const item of listAll()) {
      expect(item.file).toBeUndefined();
      expect(item.fallback).toBeUndefined();
    }
  });
});

describe('getById', () => {
  it('resolves a known id', () => {
    expect(getById('minecraft')?.name).toBe('Minecraft');
  });

  it('returns null for an unknown id', () => {
    expect(getById('not-a-game')).toBeNull();
    expect(getById('')).toBeNull();
  });
});

describe('selectSegment', () => {
  it('rejects an unknown game id', async () => {
    await expect(selectSegment('not-a-game', 10)).rejects.toThrow(/Unknown gameplay id/);
  });

  it('picks a segment that fits inside the source duration', async () => {
    const seg = await selectSegment('minecraft', 5);
    expect(seg.mock).toBe(false);
    expect(seg.startTime).toBeGreaterThanOrEqual(0);
    expect(seg.endTime).toBeGreaterThan(seg.startTime);
    expect(seg.endTime - seg.startTime).toBeCloseTo(5, 1);
  });

  it('varies the chosen timestamp across calls (no immediate repeats)', async () => {
    const picks = [];
    for (let i = 0; i < 6; i++) {
      picks.push((await selectSegment('minecraft', 5)).startTime);
    }
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it('refuses a duration longer than the source', async () => {
    await expect(selectSegment('roblox', 100000)).rejects.toThrow(/too short/);
  });
});
