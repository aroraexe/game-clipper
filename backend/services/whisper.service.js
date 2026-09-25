'use strict';
/**
 * whisper.service.js
 * ───────────────────────────────────────────────────────────
 * Generates accurate timestamp objects from the synthesized audio duration
 * without needing an actual AI transcription model installed.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OpenAI } = require('openai');

/**
 * transcribe(audioPath, outputDir, cleanStory)
 * -> Promise<WordTimestamp[]>
 *
 * WordTimestamp: { word: string, start: number, end: number }
 */
async function transcribe(audioPath, outputDir, cleanStory) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${path.basename(audioPath)}`);
  }

  // Use real OpenAI Whisper API only if key is available AND not explicitly skipped.
  // Set SKIP_WHISPER_API=true in .env to always use free math timing (recommended for free hosting).
  const skipWhisper = process.env.SKIP_WHISPER_API === 'true';

  if (!skipWhisper && process.env.OPENAI_API_KEY) {
    try {
      console.log('[Whisper] Using OpenAI Whisper API for perfect audio sync...');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });

      if (response.words && response.words.length > 0) {
        return response.words.map(w => ({
          word: w.word,
          start: w.start,
          end: w.end,
        }));
      }
    } catch (err) {
      console.warn('[Whisper] OpenAI API failed, falling back to linear sync:', err.message);
    }
  } else if (skipWhisper) {
    console.log('[Whisper] SKIP_WHISPER_API=true — using fast math timing (free, instant)');
  }

  // 2. Fallback to advanced heuristic interpolation (Free Audio Sync!)
  console.log('[Whisper] Using advanced character-weighted sync (Free fallback)');
  const ffprobeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
  let durationS = 10.0;
  try {
    const durationStr = execSync(ffprobeCmd, { encoding: 'utf8' }).trim();
    durationS = parseFloat(durationStr) || 10.0;
  } catch(e) {
    console.warn('[Whisper] Could not read audio duration, defaulting to 10s');
  }

  const defaultSample = ['One','day','a','farmer','found','a','golden','egg.'];
  const wordsArray = cleanStory ? cleanStory.split(/\s+/) : defaultSample;

  // Calculate proportional time weights per word based on character length and punctuation pauses
  let totalWeight = 0;
  const wordObjects = wordsArray.map(word => {
    let spokenWeight = word.length;
    let pauseWeight = 0;
    
    if (word.endsWith(',')) pauseWeight = 4;
    if (word.match(/[.!?]$/)) pauseWeight = 8;
    
    totalWeight += (spokenWeight + pauseWeight);
    return { word, spokenWeight, pauseWeight };
  });

  const timePerWeight = durationS / totalWeight;
  let currentTime = 0.0;

  return wordObjects.map((obj) => {
    // Spoken duration
    const wordDur = obj.spokenWeight * timePerWeight;
    const start = parseFloat(currentTime.toFixed(3));
    const end = parseFloat((currentTime + wordDur).toFixed(3));
    
    // Advance time by spoken + pause
    currentTime += (wordDur + (obj.pauseWeight * timePerWeight));
    
    return {
      word: obj.word,
      start,
      end
    };
  });
}

module.exports = { transcribe };
