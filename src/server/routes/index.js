// Assembles the API router.

import express from 'express';

import { apiKeyAuth, stripVersionPrefix } from '../middleware/index.js';
import accountsRoutes from './accounts.js';
import completionsRoutes from './completions.js';
import filesRoutes from './files.js';
import legacyRoutes from './legacy.js';
import mediaRoutes from './media.js';
import systemRoutes from './system.js';

const router = express.Router();

router.use(apiKeyAuth);
router.use(stripVersionPrefix);

router.use(completionsRoutes);
router.use(systemRoutes);
router.use(legacyRoutes);
router.use(mediaRoutes);
router.use(filesRoutes);
router.use(accountsRoutes);

export default router;
