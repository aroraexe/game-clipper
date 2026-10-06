'use strict';
const express     = require('express');
const router      = express.Router();
const videosCtrl  = require('../controllers/videos.controller');
const { requireAuth } = require('../middleware/auth.middleware');

router.post('/',                  requireAuth, videosCtrl.createJob);
router.post('/generate-story',    requireAuth, videosCtrl.generateStory);
router.get('/:jobId',             requireAuth, videosCtrl.getJob);
router.get('/:jobId/output',      videosCtrl.getOutput);

module.exports = router;
