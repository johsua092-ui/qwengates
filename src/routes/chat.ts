import crypto from 'node:crypto';
import { Context } from 'hono';
import { pickAccount, throttleAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import type { QwenFileAttachment } from '../services/qwenFileUpload.ts';
import { uploadImageAsFile, uploadLargeTextAsFile } from '../services/qwenFileUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  getModelSpecs,
  handleImageModelFallback,
} from './chatHelpers.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handleStreamingRequest } from './chatStreaming.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpers.ts';