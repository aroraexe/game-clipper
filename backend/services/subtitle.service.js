'use strict';
/**
 * subtitle.service.js
 * ───────────────────
 * Converts Whisper word timestamps → .ass subtitle file.
 *
 * Supported caption styles / presets:
 *   bold-yellow    – Large bold yellow text, black outline (default gaming look)
 *   white-highlight – White text, word highlighted in yellow
 *   word-pop       – Each word pops in with a scale animation
 *   clean          – Clean white with soft shadow, minimal styling
 */

const fs   = require('fs');
const path = require('path');

// Match the output resolution configured in ffmpeg.service.js
const VIDEO_W = parseInt(process.env.VIDEO_WIDTH,  10) || 720;
const VIDEO_H = parseInt(process.env.VIDEO_HEIGHT, 10) || 1280;

/* ── ASS time formatting ──────────────────────────────────────────────────── */
function toAssTime(seconds) {
  const h   = Math.floor(seconds / 3600);
  const m   = Math.floor((seconds % 3600) / 60);
  const s   = Math.floor(seconds % 60);
  const cs  = Math.round((seconds % 1) * 100);  // centiseconds
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/* ── Style presets ────────────────────────────────────────────────────────── */
const PRESETS = {
  'bold-yellow': {
    fontName:     'Impact',
    fontSize:     120,
    primaryColor: '&H0000FFFF',   // Yellow in ASS (AABBGGRR)
    outlineColor: '&H00000000',   // Black
    backColor:    '&H80000000',
    bold:         -1,
    outline:      5,
    shadow:       2,
    alignment:    5,              // middle-center
    marginV:      0,
    highlight:    false,
  },
  'white-highlight': {
    fontName:     'Arial Rounded MT Bold',
    fontSize:     110,
    primaryColor: '&H00FFFFFF',   // White
    outlineColor: '&H00000000',
    backColor:    '&H80000000',
    bold:         -1,
    outline:      4,
    shadow:       2,
    alignment:    5,
    marginV:      0,
    highlight:    true,
    highlightColor: '&H88FFFFFF', // White Glow for highlight
  },
  'word-pop': {
    fontName:     'Impact',
    fontSize:     130,
    primaryColor: '&H00FFFFFF',
    outlineColor: '&H88FFFFFF',   // White glow outline
    backColor:    '&H80000000',
    bold:         -1,
    outline:      6,
    shadow:       3,
    alignment:    5,
    marginV:      0,
    highlight:    false,
    pop:          true,
  },
  'clean': {
    fontName:     'Arial',
    fontSize:     90,
    primaryColor: '&H00FFFFFF',
    outlineColor: '&H00000000',
    backColor:    '&H40000000',
    bold:         0,
    outline:      2,
    shadow:       2,
    alignment:    5,
    marginV:      0,
    highlight:    false,
  },
};

/* ── Main entry ───────────────────────────────────────────────────────────── */
/**
 * generate(words, outputPath, style)
 * words:  [{word, start, end}]
 * style:  'bold-yellow' | 'white-highlight' | 'word-pop' | 'clean'
 * → string (outputPath)
 */
function hexToAssColor(hex) {
  if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const r = hex.substring(1, 3);
  const g = hex.substring(3, 5);
  const b = hex.substring(5, 7);
  return `&H00${b}${g}${r}`;
}

function generate(words, outputPath, style = 'bold-yellow', customColorHex = null) {
  if (!words || words.length === 0)
    throw new Error('No word timestamps provided for subtitle generation');

  const basePreset = PRESETS[style] || PRESETS['bold-yellow'];
  // Clone to avoid mutating global preset
  const preset = { ...basePreset };

  if (customColorHex) {
    const assColor = hexToAssColor(customColorHex);
    if (assColor) preset.primaryColor = assColor;
  }

  const header  = buildHeader(preset);
  const events  = buildEvents(words, preset);
  const content = `${header}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}`;

  fs.writeFileSync(outputPath, content, 'utf8');
  console.log(`[Subtitle] Generated ${style} ASS file → ${path.basename(outputPath)}`);
  return outputPath;
}

module.exports = { generate, PRESETS };

/* ── ASS Header ──────────────────────────────────────────────────────────── */
function buildHeader(p) {
  return `[Script Info]
Title: StoryPlay Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${VIDEO_W}
PlayResY: ${VIDEO_H}
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${p.fontName},${p.fontSize},${p.primaryColor},&H000000FF,${p.outlineColor},${p.backColor},${p.bold},0,0,0,100,100,0,0,1,${p.outline},${p.shadow},${p.alignment},60,60,${p.marginV},1
Style: Highlight,${p.fontName},${p.fontSize},${p.highlightColor || p.primaryColor},&H000000FF,${p.outlineColor},${p.backColor},-1,0,0,0,110,110,0,0,1,${p.outline + 1},${p.shadow},${p.alignment},60,60,${p.marginV},1`;
}

/* ── Event lines ─────────────────────────────────────────────────────────── */
const WORDS_PER_LINE = 4;    // words shown at once
const SHOW_AHEAD_S   = 0;    // strict timing to prevent ASS subtitle stacking

function buildEvents(words, preset) {
  const lines = [];

  // Group words into chunks of WORDS_PER_LINE
  const chunks = [];
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    chunks.push(words.slice(i, i + WORDS_PER_LINE));
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const lineStart = chunk[0].start;
    // Make the line stay on screen until the next chunk starts (to prevent flickers during pauses)
    const lineEnd   = (c < chunks.length - 1) ? chunks[c + 1][0].start : chunk[chunk.length - 1].end;

    if (preset.highlight) {
      // Word-by-word highlighting: one dialogue line per word
      lines.push(...buildHighlightedChunk(chunk, lineStart, lineEnd, preset));
    } else if (preset.pop) {
      lines.push(...buildPopChunk(chunk, preset));
    } else {
      // Simple: show whole line at once
      const text = chunk.map((w) => w.word).join(' ');
      lines.push(`Dialogue: 0,${toAssTime(lineStart)},${toAssTime(lineEnd)},Default,,0,0,0,,${text}`);
    }
  }

  return lines.join('\n');
}

function buildHighlightedChunk(chunk, lineStart, lineEnd, preset) {
  const lines = [];
  const allText = chunk.map((w) => w.word).join(' ');

  for (let wi = 0; wi < chunk.length; wi++) {
    const w = chunk[wi];
    // Build karaoke-style: highlighted word in Highlight style, others in Default
    const parts = chunk.map((cw, ci) => {
      if (ci === wi) return `{\\rHighlight}${cw.word}{\\rDefault}`;
      return cw.word;
    }).join(' ');

    const start = w.start;
    const end   = wi < chunk.length - 1
      ? chunk[wi + 1].start
      : lineEnd;

    lines.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${parts}`);
  }
  return lines;
}

function buildPopChunk(chunk, preset) {
  // Each word gets its own line with a brief pop-in (scale override)
  return chunk.map((w, wi) => {
    const start = w.start;
    // Keep word on screen until next word starts (or its own end if it's the last word)
    const end = wi < chunk.length - 1 ? chunk[wi + 1].start : w.end;
    // ASS override for scale animation (simple version: just show larger briefly)
    const text  = `{\\t(0,80,\\fscx120\\fscy120)\\t(80,160,\\fscx100\\fscy100)}${w.word}`;
    return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
  });
}
