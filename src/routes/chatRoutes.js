import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getMyConversations,
  getMessages,
  sendMessage,
  findOrCreateDirectChat,
  searchUsersForChat
} from 
"../controller/teamChatController.js";

export const router = Router();

// Protect all chat routes
router.use(requireAuth);

router.get("/conversations", getMyConversations);
router.get("/messages/:conversationId", getMessages);
router.post("/message", sendMessage);
router.post("/direct", findOrCreateDirectChat);
router.get("/users/search", searchUsersForChat);