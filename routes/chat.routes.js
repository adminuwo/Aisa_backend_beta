import express from 'express';
import * as chatController from '../controllers/chat.controller.js';
import uploadMiddleware from '../middlewares/upload.middleware.js';

const router = express.Router();

router.get('/history', chatController.getHistory);
router.delete('/history', chatController.clearHistory);
router.get('/:id', chatController.getConversation);
router.delete('/:id', chatController.deleteConversation);
router.post('/upload', uploadMiddleware, chatController.uploadAttachment); // New Route
router.post('/stream', chatController.stream);
router.post('/', chatController.chat);

export default router;
