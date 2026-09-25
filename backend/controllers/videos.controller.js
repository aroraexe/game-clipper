'use strict';
const { v4: uuidv4 }  = require('uuid');
const path             = require('path');
const jobStore         = require('../jobs/jobStore');
const { enqueue }      = require('../jobs/renderQueue');
const storyService     = require('../services/story.service');
const gameplayService  = require('../services/gameplay.service');

function parseStoryResponse(raw) {
  let text = raw.trim();

  // Remove markdown code fences
  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find JSON object if model added extra text
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed.story === "string" && parsed.story.trim()) {
        return parsed.story.trim();
      }
    } catch (e) {
      // Fall through to regex extraction if JSON parse fails
    }
  }

  // Nemotron-specific fallback: extract the drafted story from its chain of thought
  const draftMatch = text.match(/Draft:[\s\S]*?\"([^\"]+)\"/i) || text.match(/\"([^\"]+)\"/i);
  if (draftMatch && draftMatch[1]) {
    return draftMatch[1].trim();
  }

  throw new Error("Story generator returned invalid format");
}

/* ── POST /api/videos/generate-story ─────────────────────────────────────── */
exports.generateStory = async (req, res, next) => {
  try {
    const { duration } = req.body;
    const dur = parseInt(duration) || 45;
    const wordCount = Math.floor(dur * 2.5);

    const generateWithRetry = async (retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer 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'
            },
            body: JSON.stringify({
              model: 'nvidia/nemotron-3-ultra-550b-a55b',
              messages: [
                {
                  role: 'system',
                  content: `You are a strict JSON API. You must respond with exactly one JSON object and absolutely nothing else. No thinking, no counting, no explanations.

OUTPUT FORMAT:
{
  "story": "..."
}

STORY REQUIREMENTS:
- Write in first person.
- Make it dramatic, engaging and suitable for a gaming Short.
- Target approximately ${wordCount} words.
- The story must be natural when read aloud.
- End with a compelling twist, reveal, or payoff.
- Do not stop mid-sentence.`
                },
                {
                  role: 'user',
                  content: `Generate the story. Output ONLY JSON: {"story": "your generated story text goes here"}`
                }
              ],
              max_tokens: 500, // Safe buffer for the JSON
              temperature: 0.7
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error(`[NVIDIA API Error Attempt ${i+1}]:`, errText);
            if (i === retries - 1) throw new Error('NVIDIA API Error: ' + errText);
            await new Promise(resolve => setTimeout(resolve, 1500)); // wait 1.5s before retry
            continue;
          }

          const data = await response.json();
          let rawContent = data.choices[0].message.content || "";
          
          try {
            return parseStoryResponse(rawContent);
          } catch (e) {
            console.error(`[Parse Error Attempt ${i+1}]:`, e.message, "RAW:", rawContent);
            if (i === retries - 1) throw new Error("Failed to parse story after multiple attempts.");
            continue;
          }
        } catch (err) {
          if (i === retries - 1) throw err;
        }
      }
    };

    let story = "";
    try {
      story = await generateWithRetry(3);
    } catch (e) {
      console.error("[Story Gen Fallback Triggered]:", e);
      // Fallback story so the user is never completely blocked
      story = "I stared at the flickering screen, the last boss's health bar a thin red line. My fingers trembled over the controller, each heartbeat syncing with the pulsing music. One final combo, a perfect parry, and the arena erupted in light. The victory screen flashed—then the console whispered my real name, and the lights in my room went out.";
    }

    // Server-side validation just to log it (client handles UX)
    const words = story.trim().split(/\s+/).length;
    console.log(`[AI] Generated story: ${words} words (target: ${wordCount})`);

    res.json({ story });
  } catch (err) {
    next(err);
  }
};

/* ── POST /api/videos ────────────────────────────────────────────────────── */
exports.createJob = async (req, res, next) => {
  try {
    const { story, gameplayId, captionStyle, captionColor, voice, duration } = req.body;

    /* Validate inputs */
    const storyErr = storyService.validate(story);
    if (storyErr) return res.status(400).json({ error: storyErr });

    if (!gameplayService.getById(gameplayId))
      return res.status(400).json({ error: 'Invalid gameplayId' });

    const allowedStyles   = ['bold-yellow', 'white-highlight', 'word-pop', 'clean'];
    const allowedVoices   = ['default', 'energetic', 'calm', 'narrator'];
    const allowedDuration = [30, 45, 60];

    if (captionStyle && !allowedStyles.includes(captionStyle))
      return res.status(400).json({ error: `captionStyle must be one of: ${allowedStyles.join(', ')}` });

    const dur = Number(duration);
    if (duration !== undefined && !allowedDuration.includes(dur))
      return res.status(400).json({ error: `duration must be one of: ${allowedDuration.join(', ')}` });

    if (voice && !allowedVoices.includes(voice))
      return res.status(400).json({ error: `voice must be one of: ${allowedVoices.join(', ')}` });

    if (captionColor && !/^#[0-9A-Fa-f]{6}$/.test(captionColor))
      return res.status(400).json({ error: `captionColor must be a valid hex color code` });

    /* Create job */
    const jobId = uuidv4();
    const job = jobStore.create(jobId, {
      story,
      gameplayId,
      captionStyle: captionStyle || 'bold-yellow',
      captionColor: captionColor || '#ffffff',
      voice:        voice        || 'default',
      duration:     dur          || 45,
    });

    /* Enqueue for async processing */
    enqueue(jobId);

    res.status(202).json({
      jobId,
      status:  'queued',
      message: 'Job accepted — poll GET /api/videos/:jobId for status',
    });
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/videos/:jobId ──────────────────────────────────────────────── */
exports.getJob = (req, res, next) => {
  try {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    /* Never expose internal paths */
    const safe = {
      jobId:     job.jobId,
      status:    job.status,
      stage:     job.stage,
      progress:  job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error:     job.error || null,
      outputUrl: job.status === 'completed'
        ? `/api/videos/${job.jobId}/output`
        : null,
    };
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/videos/:jobId/output ──────────────────────────────────────── */
exports.getOutput = (req, res, next) => {
  try {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed')
      return res.status(409).json({ error: 'Job not completed yet', status: job.status });

    if (!job.outputPath || !require('fs').existsSync(job.outputPath)) {
      return res.status(500).json({ error: 'Output file missing or deleted from server' });
    }

    if (req.query.download === 'true') {
      return res.download(job.outputPath, `storyplay_${req.params.jobId}.mp4`, (err) => {
        if (err && !res.headersSent) next(err);
      });
    }

    res.sendFile(job.outputPath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
};
