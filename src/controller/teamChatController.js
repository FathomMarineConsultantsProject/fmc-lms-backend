import { db } from "../db.js";
import { pusher } from "../config/pusher.js";

// -------------------- GET /chat/conversations --------------------

export const getMyConversations = async (req, res) => {
  const myUserId = req.user?.user_id;

  try {
    const { rows } = await db.query(
      `SELECT 
         c.id, c.type, c.name, c.updated_at,
         cp.last_read_at,
         -- Count unread messages
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > cp.last_read_at)::int AS unread_count,
         -- If direct chat, get the other person's name
         (SELECT u.full_name 
          FROM conversation_participants cp2 
          JOIN users u ON u.user_id = cp2.user_id 
          WHERE cp2.conversation_id = c.id AND cp2.user_id != $1 LIMIT 1
         ) AS other_user_name
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id
       WHERE cp.user_id = $1
       ORDER BY c.updated_at DESC`,
      [myUserId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Error fetching conversations:", err);
    return res.status(500).json({ error: "Failed to fetch conversations" });
  }
};

// -------------------- GET /chat/messages/:conversationId --------------------

export const getMessages = async (req, res) => {
  const myUserId = req.user?.user_id;
  const { conversationId } = req.params;

  try {
    //  Verify the user is actually a participant in this room
    const checkRes = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, myUserId]
    );
    if (checkRes.rows.length === 0) return res.status(403).json({ error: "Access denied" });

    //  Fetch the messages
    const { rows } = await db.query(
      `SELECT m.*, u.full_name AS sender_name 
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.user_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [conversationId]
    );

    //  Update last_read_at so unread badges clear out
    await db.query(
      "UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, myUserId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Error fetching messages:", err);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
};

// -------------------- POST /chat/message --------------------
export const sendMessage = async (req, res) => {
    const myUserId = req.user?.user_id;
    const { conversation_id, content, message_type = 'text' } = req.body;
  
    if (!content || !conversation_id) {
      return res.status(400).json({ error: "Content and conversation_id are required" });
    }
  
    try {
      const checkRes = await db.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversation_id, myUserId]
      );
      if (checkRes.rows.length === 0) return res.status(403).json({ error: "Access denied" });
  
      await db.query("BEGIN");
  
      const insertRes = await db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, message_type) 
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [conversation_id, myUserId, content, message_type]
      );
      const newMessage = insertRes.rows[0];
  
      await db.query(
        "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
        [conversation_id]
      );
  
      await db.query("COMMIT");
  
      const userRes = await db.query("SELECT full_name FROM users WHERE user_id = $1", [myUserId]);
      newMessage.sender_name = userRes.rows[0]?.full_name;
  
      // 🚨 1. Broadcast to the active chat room (Updates the chat history UI)
      await pusher.trigger(`conversation-${conversation_id}`, "new-message", newMessage);
  
      // 🚨 2. GLOBAL NOTIFICATIONS: Broadcast to the individual users for the red badge
      // Find all OTHER participants in this room to notify them
      const participantsRes = await db.query(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2",
        [conversation_id, myUserId]
      );
  
      // Send a push directly to their personal channel
      for (const p of participantsRes.rows) {
        await pusher.trigger(`user-${p.user_id}`, "unread-update", {
          conversation_id,
          sender_name: newMessage.sender_name,
          content: content.substring(0, 40) + "..." 
        });
      }
  
      return res.status(201).json(newMessage);
    } catch (err) {
      await db.query("ROLLBACK");
      console.error("Error sending message:", err);
      return res.status(500).json({ error: "Failed to send message" });
    }
  };
  
  
  // -------------------- POST /chat/direct --------------------
  export const findOrCreateDirectChat = async (req, res) => {
    const myUserId = req.user?.user_id;
    const { target_user_id } = req.body;
  
    if (!target_user_id) return res.status(400).json({ error: "target_user_id is required" });
  
    try {
     
      // Fetch both users to verify their roles and companies
      const usersRes = await db.query(
        "SELECT user_id, company_id, role_id FROM users WHERE user_id = $1 OR user_id = $2",
        [myUserId, target_user_id]
      );
  
      let myUser, targetUser;
      for (const u of usersRes.rows) {
        if (u.user_id === myUserId) myUser = u;
        if (u.user_id === target_user_id) targetUser = u;
      }
  
      if (!targetUser) return res.status(404).json({ error: "Target user not found" });
  
      // If NEITHER user is a Superadmin (Role 1), their companies MUST match.
      if (myUser.role_id !== 1 && targetUser.role_id !== 1 && myUser.company_id !== targetUser.company_id) {
        return res.status(403).json({ 
          error: "Cross-company messaging is disabled. You can only message users within your own company." 
        });
      }
  
      //  Check if chat already exists
      const existingChat = await db.query(
        `SELECT c.id 
         FROM conversations c
         JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
         JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
         WHERE c.type = 'direct' 
           AND cp1.user_id = $1 
           AND cp2.user_id = $2
         LIMIT 1`,
        [myUserId, target_user_id]
      );
  
      if (existingChat.rows.length > 0) {
        return res.json({ conversation_id: existingChat.rows[0].id, is_new: false });
      }
  
      //  Create the chat
      await db.query("BEGIN");
      
      // Assign the chat to the non-superadmin's company so it stays organized
      const assignedCompanyId = myUser.role_id !== 1 ? myUser.company_id : targetUser.company_id;
  
      const newConv = await db.query(
        "INSERT INTO conversations (type, company_id) VALUES ('direct', $1) RETURNING id",
        [assignedCompanyId]
      );
      const newConvId = newConv.rows[0].id;
  
      await db.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES 
         ($1, $2, 'member'), ($1, $3, 'member')`,
        [newConvId, myUserId, target_user_id]
      );
  
      await db.query("COMMIT");
  
      return res.status(201).json({ conversation_id: newConvId, is_new: true });
    } catch (err) {
      await db.query("ROLLBACK");
      console.error("Error creating direct chat:", err);
      return res.status(500).json({ error: "Failed to create chat" });
    }
  };

  // -------------------- GET /chat/users/search --------------------
export const searchUsersForChat = async (req, res) => {
  const myUserId = req.user?.user_id;
  const myRoleId = Number(req.user?.role_id);
  const myCompanyId = req.user?.company_id;
  const q = req.query.q || '';

  if (!q || q.length < 2) return res.json([]);

  try {
      let queryStr = `
          SELECT user_id, full_name, rank, company_id 
          FROM users 
          WHERE (full_name ILIKE $1 OR seafarer_id ILIKE $1) AND user_id != $2
      `;
      const params = [`%${q}%`, myUserId];

    
      
      if (myRoleId !== 1) {
          queryStr += ` AND company_id = $3`;
          params.push(myCompanyId);
      }

      queryStr += ` LIMIT 10`;

      const { rows } = await db.query(queryStr, params);
      return res.json(rows);
  } catch (err) {
      console.error("Error searching chat users:", err);
      return res.status(500).json({ error: "Failed to search users" });
  }
};
