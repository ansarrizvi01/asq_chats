const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { query, transaction } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "projectchat_session";
const SESSION_DAYS = 14;

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch (_error) {
    // Invalid origins are rejected below.
  }
  return res.status(403).json({ error: "Cross-origin request blocked." });
});

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

function text(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizedEmail(value) {
  return text(value, 254).toLowerCase();
}

function publicOrigin(req) {
  return String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

async function setSession(res, userId) {
  const sessionToken = token();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await query("DELETE FROM sessions WHERE expires_at <= NOW()");
  await query(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionToken, userId, nowIso(), expiresAt]
  );
  res.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

async function clearSession(req, res) {
  const sessionToken = req.cookies[SESSION_COOKIE];
  if (sessionToken) await query("DELETE FROM sessions WHERE token = $1", [sessionToken]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

async function getAuthUser(req) {
  const sessionToken = req.cookies[SESSION_COOKIE];
  if (!sessionToken) return null;
  const result = await query(
    `SELECT u.id, u.name, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0] || null;
}

const requireAuth = asyncHandler(async (req, res, next) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  req.user = user;
  next();
});

async function getProjectMembership(projectId, userId, executor = { query }) {
  const result = await executor.query(
    `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  return result.rows[0] || null;
}

async function getRoomMembership(roomId, userId, executor = { query }) {
  const result = await executor.query(
    `SELECT rm.role, r.id, r.project_id, r.name, r.description, r.room_type, r.created_by, r.created_at
     FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     WHERE r.id = $1 AND rm.user_id = $2`,
    [roomId, userId]
  );
  const record = result.rows[0];
  if (!record) return null;
  return {
    role: record.role,
    room: {
      id: record.id,
      project_id: record.project_id,
      name: record.name,
      description: record.description,
      room_type: record.room_type,
      created_by: record.created_by,
      created_at: record.created_at
    }
  };
}

const requireProjectFullAccess = asyncHandler(async (req, res, next) => {
  const membership = await getProjectMembership(req.params.projectId, req.user.id);
  if (!membership || membership.role !== "full") {
    return res.status(403).json({ error: "Full project access required." });
  }
  req.projectMembership = membership;
  next();
});

const requireRoomMembership = asyncHandler(async (req, res, next) => {
  const membership = await getRoomMembership(req.params.roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "You do not have access to this room." });
  req.roomMembership = membership;
  next();
});

const requireRoomFullAccess = asyncHandler(async (req, res, next) => {
  const membership = await getRoomMembership(req.params.roomId, req.user.id);
  if (!membership || membership.role !== "full") {
    return res.status(403).json({ error: "Full room access required." });
  }
  req.roomMembership = membership;
  next();
});

async function summarizeWorkspace(userId) {
  const projectsResult = await query(
    `SELECT p.id, p.name, p.description, pm.role
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = $1
     ORDER BY p.created_at ASC`,
    [userId]
  );

  return Promise.all(projectsResult.rows.map(async (project) => {
    const roomsResult = await query(
      `SELECT r.id, r.project_id, r.name, r.description, r.room_type, rm.role
       FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE r.project_id = $1 AND rm.user_id = $2
       ORDER BY r.created_at ASC`,
      [project.id, userId]
    );

    const rooms = await Promise.all(roomsResult.rows.map(async (room) => {
      const [lastMessageResult, openTasksResult] = await Promise.all([
        query(
          `SELECT m.text, m.created_at, u.name AS author_name
           FROM messages m
           JOIN users u ON u.id = m.author_id
           WHERE m.room_id = $1
           ORDER BY m.created_at DESC
           LIMIT 1`,
          [room.id]
        ),
        query(`SELECT COUNT(*) AS count FROM tasks WHERE room_id = $1 AND status = 'open'`, [room.id])
      ]);
      return {
        ...room,
        lastMessage: lastMessageResult.rows[0] || null,
        openTasks: Number(openTasksResult.rows[0].count)
      };
    }));

    return { ...project, rooms };
  }));
}

async function roomDetails(roomId, userId) {
  const roomResult = await query(
    `SELECT r.*, p.name AS project_name, p.description AS project_description
     FROM rooms r
     JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1`,
    [roomId]
  );
  const room = roomResult.rows[0];
  if (!room) return null;

  const [membership, membersResult, messagesResult, tasksResult, invitesResult] = await Promise.all([
    getRoomMembership(roomId, userId),
    query(
      `SELECT u.id, u.name, u.email, rm.role
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY u.name`,
      [roomId]
    ),
    query(
      `SELECT m.id, m.room_id, m.author_id, u.name AS author_name, m.kind, m.text, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.room_id = $1
       ORDER BY m.created_at ASC`,
      [roomId]
    ),
    query(
      `SELECT t.*, assignee.name AS assignee_name, creator.name AS created_by_name
       FROM tasks t
       JOIN users assignee ON assignee.id = t.assignee_id
       JOIN users creator ON creator.id = t.created_by
       WHERE t.room_id = $1
       ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.updated_at DESC`,
      [roomId]
    ),
    query(
      `SELECT i.id, i.email, i.role, i.status, i.token, i.created_at, u.name AS invited_by_name
       FROM invites i
       JOIN users u ON u.id = i.invited_by
       WHERE i.project_id = $1 AND (i.room_id IS NULL OR i.room_id = $2)
       ORDER BY i.created_at DESC`,
      [room.project_id, roomId]
    )
  ]);

  const messageIds = messagesResult.rows.map((message) => message.id);
  const taskIds = tasksResult.rows.map((taskRecord) => taskRecord.id);
  const [mentionsResult, updatesResult] = await Promise.all([
    messageIds.length
      ? query(
          `SELECT mm.message_id, u.id, u.name
           FROM message_mentions mm
           JOIN users u ON u.id = mm.user_id
           WHERE mm.message_id = ANY($1::text[])
           ORDER BY u.name`,
          [messageIds]
        )
      : Promise.resolve({ rows: [] }),
    taskIds.length
      ? query(
          `SELECT tu.id, tu.task_id, tu.text, tu.created_at, u.name AS author_name
           FROM task_updates tu
           JOIN users u ON u.id = tu.author_id
           WHERE tu.task_id = ANY($1::text[])
           ORDER BY tu.created_at DESC`,
          [taskIds]
        )
      : Promise.resolve({ rows: [] })
  ]);

  const mentionsByMessage = new Map();
  mentionsResult.rows.forEach((mention) => {
    const list = mentionsByMessage.get(mention.message_id) || [];
    list.push({ id: mention.id, name: mention.name });
    mentionsByMessage.set(mention.message_id, list);
  });
  const updatesByTask = new Map();
  updatesResult.rows.forEach((update) => {
    const list = updatesByTask.get(update.task_id) || [];
    list.push(update);
    updatesByTask.set(update.task_id, list);
  });

  return {
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
      roomType: room.room_type,
      projectId: room.project_id,
      projectName: room.project_name,
      projectDescription: room.project_description
    },
    membership,
    members: membersResult.rows,
    messages: messagesResult.rows.map((message) => ({
      ...message,
      mentions: mentionsByMessage.get(message.id) || []
    })),
    tasks: tasksResult.rows.map((taskRecord) => ({
      ...taskRecord,
      updates: updatesByTask.get(taskRecord.id) || []
    })),
    invites: invitesResult.rows
  };
}

app.get("/api/health", asyncHandler(async (_req, res) => {
  await query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const name = text(req.body.name, 100);
  const email = normalizedEmail(req.body.email);
  const password = String(req.body.password || "");
  if (!name || !email || password.length < 8) {
    return res.status(400).json({ error: "Name, email, and a password of at least 8 characters are required." });
  }
  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows[0]) return res.status(409).json({ error: "An account with that email already exists." });

  const userId = id();
  const passwordHash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [userId, name, email, passwordHash, nowIso()]
  );
  await setSession(res, userId);
  res.json({ user: { id: userId, name, email } });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const email = normalizedEmail(req.body.email);
  const userResult = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = userResult.rows[0];
  if (!user || !await bcrypt.compare(String(req.body.password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  await setSession(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.post("/api/auth/logout", requireAuth, asyncHandler(async (req, res) => {
  await clearSession(req, res);
  res.json({ ok: true });
}));

app.get("/api/me", asyncHandler(async (req, res) => {
  res.json({ user: await getAuthUser(req) });
}));

app.get("/api/bootstrap", requireAuth, asyncHandler(async (req, res) => {
  const [workspace, pendingInvitesResult] = await Promise.all([
    summarizeWorkspace(req.user.id),
    query(
      `SELECT i.id, i.token, i.email, i.role, i.status, i.created_at,
              p.name AS project_name, r.name AS room_name
       FROM invites i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN rooms r ON r.id = i.room_id
       WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`,
      [req.user.email]
    )
  ]);
  res.json({ user: req.user, workspace, pendingInvites: pendingInvitesResult.rows });
}));

app.get("/api/rooms/:roomId", requireAuth, requireRoomMembership, asyncHandler(async (req, res) => {
  res.json(await roomDetails(req.params.roomId, req.user.id));
}));

app.post("/api/projects", requireAuth, asyncHandler(async (req, res) => {
  const name = text(req.body.name, 120);
  const description = text(req.body.description, 1000);
  if (!name) return res.status(400).json({ error: "Project name is required." });
  const projectId = id();
  const createdAt = nowIso();

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO projects (id, name, description, owner_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [projectId, name, description, req.user.id, createdAt]
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES ($1, $2, 'full', $3)`,
      [projectId, req.user.id, createdAt]
    );
  });
  res.json({ projectId });
}));

app.post("/api/projects/:projectId/rooms", requireAuth, requireProjectFullAccess, asyncHandler(async (req, res) => {
  const name = text(req.body.name, 120);
  const description = text(req.body.description, 1000);
  if (!name) return res.status(400).json({ error: "Subproject name is required." });
  const roomId = id();
  const createdAt = nowIso();

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO rooms (id, project_id, name, description, room_type, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'subproject', $5, $6)`,
      [roomId, req.params.projectId, name, description, req.user.id, createdAt]
    );
    await client.query(
      `INSERT INTO room_members (room_id, user_id, role, added_at)
       SELECT $1, user_id, role, $2::timestamptz FROM project_members WHERE project_id = $3`,
      [roomId, createdAt, req.params.projectId]
    );
    await client.query(
      `INSERT INTO messages (id, room_id, author_id, kind, text, created_at)
       VALUES ($1, $2, $3, 'alert', $4, $5)`,
      [id(), roomId, req.user.id, "Subproject created. Use this chat for focused updates and tasks.", createdAt]
    );
  });
  res.json({ roomId });
}));

app.post("/api/invites", requireAuth, asyncHandler(async (req, res) => {
  const projectId = text(req.body.projectId, 100);
  const roomId = text(req.body.roomId, 100) || null;
  const email = normalizedEmail(req.body.email);
  const role = req.body.role === "readonly" ? "readonly" : "full";
  if (!projectId || !email) return res.status(400).json({ error: "Project, email, and role are required." });

  const projectMembership = await getProjectMembership(projectId, req.user.id);
  if (!projectMembership || projectMembership.role !== "full") {
    return res.status(403).json({ error: "Full project access required to invite members." });
  }
  if (roomId) {
    const roomResult = await query("SELECT id FROM rooms WHERE id = $1 AND project_id = $2", [roomId, projectId]);
    if (!roomResult.rows[0]) return res.status(400).json({ error: "That subproject does not belong to this project." });
  }
  const duplicate = await query(
    `SELECT id FROM invites
     WHERE email = $1 AND project_id = $2
       AND ((room_id = $3) OR (room_id IS NULL AND $3::text IS NULL))
       AND status = 'pending' AND expires_at > NOW()`,
    [email, projectId, roomId]
  );
  if (duplicate.rows[0]) return res.status(409).json({ error: "A pending invite already exists for this person." });

  const invite = {
    id: id(),
    token: token(),
    email,
    project_id: projectId,
    room_id: roomId,
    role,
    status: "pending",
    invited_by: req.user.id,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  await query(
    `INSERT INTO invites (id, token, email, project_id, room_id, role, status, invited_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)`,
    [invite.id, invite.token, invite.email, invite.project_id, invite.room_id, invite.role, invite.invited_by, invite.created_at, invite.expires_at]
  );
  res.json({ invite, inviteUrl: `${publicOrigin(req)}/?invite=${invite.token}` });
}));

app.post("/api/invites/:token/accept", requireAuth, asyncHandler(async (req, res) => {
  const inviteResult = await query(
    "SELECT * FROM invites WHERE token = $1 AND status = 'pending' AND expires_at > NOW()",
    [req.params.token]
  );
  const invite = inviteResult.rows[0];
  if (!invite || invite.status !== "pending") {
    return res.status(404).json({ error: "Invite not found or already accepted." });
  }
  if (invite.email !== req.user.email) {
    return res.status(403).json({ error: "This invite is for another email address." });
  }

  await transaction(async (client) => {
    const projectRole = invite.room_id ? "readonly" : invite.role;
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, added_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE
       SET role = CASE WHEN EXCLUDED.role = 'full' THEN 'full' ELSE project_members.role END`,
      [invite.project_id, req.user.id, projectRole, nowIso()]
    );

    if (invite.room_id) {
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role, added_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [invite.room_id, req.user.id, invite.role, nowIso()]
      );
    } else {
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role, added_at)
         SELECT id, $1, $2, $3::timestamptz FROM rooms WHERE project_id = $4
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [req.user.id, invite.role, nowIso(), invite.project_id]
      );
    }

    await client.query(
      `UPDATE invites SET status = 'accepted', accepted_at = $1 WHERE id = $2`,
      [nowIso(), invite.id]
    );
  });
  res.json({ ok: true });
}));

app.post("/api/rooms/:roomId/messages", requireAuth, requireRoomFullAccess, asyncHandler(async (req, res) => {
  const messageText = text(req.body.text, 5000);
  const kind = ["update", "task", "alert"].includes(req.body.kind) ? req.body.kind : "update";
  const mentionIds = Array.isArray(req.body.mentionIds) ? [...new Set(req.body.mentionIds)].slice(0, 25) : [];
  if (!messageText) return res.status(400).json({ error: "Message text is required." });
  const messageId = id();
  const createdAt = nowIso();

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO messages (id, room_id, author_id, kind, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, req.params.roomId, req.user.id, kind, messageText, createdAt]
    );
    for (const memberId of mentionIds) {
      await client.query(
        `INSERT INTO message_mentions (message_id, user_id)
         SELECT $1, user_id FROM room_members WHERE room_id = $2 AND user_id = $3
         ON CONFLICT DO NOTHING`,
        [messageId, req.params.roomId, memberId]
      );
    }
  });
  res.json({ ok: true });
}));

app.post("/api/rooms/:roomId/tasks", requireAuth, requireRoomFullAccess, asyncHandler(async (req, res) => {
  const title = text(req.body.title, 200);
  const note = text(req.body.note, 2000);
  const assigneeId = text(req.body.assigneeId, 100);
  if (!title || !assigneeId) return res.status(400).json({ error: "Task title and assignee are required." });

  const memberResult = await query(
    "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
    [req.params.roomId, assigneeId]
  );
  if (!memberResult.rows[0]) return res.status(400).json({ error: "Assignee must be a member of this room." });

  const taskId = id();
  const createdAt = nowIso();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO tasks (id, room_id, title, note, assignee_id, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $7)`,
      [taskId, req.params.roomId, title, note, assigneeId, req.user.id, createdAt]
    );
    await client.query(
      `INSERT INTO task_updates (id, task_id, author_id, text, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id(), taskId, req.user.id, "Task created.", createdAt]
    );
    await client.query(
      `INSERT INTO messages (id, room_id, author_id, kind, text, created_at) VALUES ($1, $2, $3, 'task', $4, $5)`,
      [id(), req.params.roomId, req.user.id, `Created task "${title}".`, createdAt]
    );
  });
  res.json({ ok: true, taskId });
}));

app.patch("/api/tasks/:taskId", requireAuth, asyncHandler(async (req, res) => {
  const taskResult = await query("SELECT * FROM tasks WHERE id = $1", [req.params.taskId]);
  const task = taskResult.rows[0];
  if (!task) return res.status(404).json({ error: "Task not found." });
  const membership = await getRoomMembership(task.room_id, req.user.id);
  if (!membership || membership.role !== "full") {
    return res.status(403).json({ error: "Full room access required." });
  }
  const nextStatus = req.body.status === "done" ? "done" : "open";
  const updatedAt = nowIso();
  await transaction(async (client) => {
    await client.query("UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3", [nextStatus, updatedAt, task.id]);
    await client.query(
      `INSERT INTO messages (id, room_id, author_id, kind, text, created_at) VALUES ($1, $2, $3, 'task', $4, $5)`,
      [id(), task.room_id, req.user.id, `${nextStatus === "done" ? "Completed" : "Re-opened"} task: ${task.title}`, updatedAt]
    );
  });
  res.json({ ok: true });
}));

app.post("/api/tasks/:taskId/updates", requireAuth, asyncHandler(async (req, res) => {
  const taskResult = await query("SELECT * FROM tasks WHERE id = $1", [req.params.taskId]);
  const task = taskResult.rows[0];
  if (!task) return res.status(404).json({ error: "Task not found." });
  const membership = await getRoomMembership(task.room_id, req.user.id);
  if (!membership || membership.role !== "full") {
    return res.status(403).json({ error: "Full room access required." });
  }
  const updateText = text(req.body.text, 2000);
  if (!updateText) return res.status(400).json({ error: "Update text is required." });
  const createdAt = nowIso();

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO task_updates (id, task_id, author_id, text, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id(), task.id, req.user.id, updateText, createdAt]
    );
    await client.query("UPDATE tasks SET updated_at = $1 WHERE id = $2", [createdAt, task.id]);
    await client.query(
      `INSERT INTO messages (id, room_id, author_id, kind, text, created_at) VALUES ($1, $2, $3, 'update', $4, $5)`,
      [id(), task.room_id, req.user.id, `Task update on "${task.title}": ${updateText}`, createdAt]
    );
  });
  res.json({ ok: true });
}));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === "23505") {
    return res.status(409).json({ error: "That record already exists." });
  }
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ProjectChat running on http://localhost:${PORT}`);
  });
}

module.exports = app;
