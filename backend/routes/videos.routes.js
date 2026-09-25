'use strict';
const express     = require('express');
const router      = express.Router();
const videosCtrl  = require('../controllers/videos.controller');

router.post('/',                  videosCtrl.createJob);
router.post('/generate-story',    videosCtrl.generateStory);
router.get('/:jobId',             videosCtrl.getJob);
router.get('/:jobId/output',      videosCtrl.getOutput);

module.exports = router;
