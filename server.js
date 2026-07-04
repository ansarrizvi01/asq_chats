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
  const configuredAdmin = normalizedEmail(process.env.ADMIN_EMAIL);
  if (configuredAdmin) {
    await query(
      `UPDATE users
       SET is_admin = (email = $1),
           approval_status = CASE WHEN email = $1 THEN 'approved' ELSE approval_status END
       WHERE is_admin = TRUE OR email = $1`,
      [configuredAdmin]
    );
  }
  const result = await query(
    `SELECT u.id, u.name, u.email, u.is_admin, u.approval_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0] || null;
}

async function ensureAdminMemberships(userId) {
  const addedAt = nowIso();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, access_scope, added_at)
       SELECT id, $1, 'full', 'project', $2::timestamptz FROM projects
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'full', access_scope = 'project'`,
      [userId, addedAt]
    );
    await client.query(
      `INSERT INTO room_members (room_id, user_id, role, added_at)
       SELECT id, $1, 'full', $2::timestamptz FROM rooms
       ON CONFLICT (room_id, user_id) DO UPDATE SET role = 'full'`,
      [userId, addedAt]
    );
  });
}

const requireSignedIn = asyncHandler(async (req, res, next) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  req.user = user;
  next();
});

const requireAuth = [requireSignedIn, (req, res, next) => {
  if (req.user.approval_status !== "approved") {
    return res.status(403).json({ error: "Your account is waiting for admin approval." });
  }
  next();
}];

const requireAdmin = [
  ...requireAuth,
  asyncHandler(async (req, res, next) => {
    if (!req.user.is_admin) return res.status(403).json({ error: "Administrator access required." });
    await ensureAdminMemberships(req.user.id);
    next();
  })
];

async function getProjectMembership(projectId, userId, executor = { query }) {
  const result = await executor.query(
    `SELECT role, access_scope FROM project_members WHERE project_id = $1 AND user_id = $2`,
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

async function getManageableUser(userId) {
  const result = await query(
    "SELECT id, name, email, is_admin, approval_status FROM users WHERE id = $1",
    [userId]
  );
  return result.rows[0] || null;
}

async function assignUserAccess({ userId, projectId, roomId, role }) {
  const [user, projectResult] = await Promise.all([
    getManageableUser(userId),
    query("SELECT id FROM projects WHERE id = $1", [projectId])
  ]);
  if (!user) return { error: "User not found.", status: 404 };
  if (user.is_admin) return { error: "The global administrator already has full access everywhere.", status: 400 };
  if (!projectResult.rows[0]) return { error: "Project not found.", status: 404 };

  if (roomId) {
    const roomResult = await query("SELECT id FROM rooms WHERE id = $1 AND project_id = $2", [roomId, projectId]);
    if (!roomResult.rows[0]) return { error: "Subproject chat not found in the selected project.", status: 404 };
  }

  const assignedAt = nowIso();
  await transaction(async (client) => {
    await client.query("UPDATE users SET approval_status = 'approved' WHERE id = $1", [userId]);

    if (roomId) {
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role, access_scope, added_at)
         VALUES ($1, $2, 'readonly', 'container', $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
         SET access_scope = project_members.access_scope,
             role = project_members.role`,
        [projectId, userId, assignedAt]
      );
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role, added_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [roomId, userId, role, assignedAt]
      );
    } else {
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role, access_scope, added_at)
         VALUES ($1, $2, $3, 'project', $4)
         ON CONFLICT (project_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, access_scope = 'project'`,
        [projectId, userId, role, assignedAt]
      );
      await client.query(
        `INSERT INTO room_members (room_id, user_id, role, added_at)
         SELECT id, $1, $2, $3::timestamptz FROM rooms WHERE project_id = $4
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [userId, role, assignedAt, projectId]
      );
    }

    await client.query(
      `UPDATE invites SET status = 'accepted', accepted_at = $1
       WHERE email = $2 AND project_id = $3 AND status = 'pending'`,
      [assignedAt, user.email, projectId]
    );
  });
  return { ok: true };
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
  const userCount = await query("SELECT COUNT(*) AS count FROM users");
  const configuredAdmin = normalizedEmail(process.env.ADMIN_EMAIL);
  const isAdmin = email === configuredAdmin || (!configuredAdmin && Number(userCount.rows[0].count) === 0);
  const approvalStatus = isAdmin ? "approved" : "pending";
  await query(
    `INSERT INTO users (id, name, email, password_hash, is_admin, approval_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, name, email, passwordHash, isAdmin, approvalStatus, nowIso()]
  );
  await setSession(res, userId);
  res.json({ user: { id: userId, name, email, is_admin: isAdmin, approval_status: approvalStatus } });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const email = normalizedEmail(req.body.email);
  const userResult = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = userResult.rows[0];
  if (!user || !await bcrypt.compare(String(req.body.password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  await setSession(res, user.id);
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      is_admin: user.is_admin,
      approval_status: user.approval_status
    }
  });
}));

app.post("/api/auth/logout", requireSignedIn, asyncHandler(async (req, res) => {
  await clearSession(req, res);
  res.json({ ok: true });
}));

app.get("/api/me", asyncHandler(async (req, res) => {
  res.json({ user: await getAuthUser(req) });
}));

app.get("/api/bootstrap", requireAuth, asyncHandler(async (req, res) => {
  if (req.user.is_admin) await ensureAdminMemberships(req.user.id);
  const [workspace, pendingInvitesResult, pendingUsersResult] = await Promise.all([
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
    ),
    req.user.is_admin
      ? query("SELECT COUNT(*) AS count FROM users WHERE approval_status = 'pending'")
      : Promise.resolve({ rows: [{ count: 0 }] })
  ]);
  res.json({
    user: req.user,
    workspace,
    pendingInvites: pendingInvitesResult.rows,
    pendingApprovalCount: Number(pendingUsersResult.rows[0].count)
  });
}));

app.get("/api/admin/overview", requireAdmin, asyncHandler(async (_req, res) => {
  const [usersResult, projectsResult, roomsResult] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.email, u.created_at,
              i.project_id AS requested_project_id, p.name AS requested_project_name
       FROM users u
       LEFT JOIN invites i ON i.email = u.email
         AND i.status = 'pending' AND i.expires_at > NOW()
       LEFT JOIN projects p ON p.id = i.project_id
       WHERE u.approval_status = 'pending'
       ORDER BY u.created_at ASC`
    ),
    query("SELECT id, name, description FROM projects ORDER BY created_at ASC"),
    query("SELECT id, project_id, name, room_type FROM rooms ORDER BY created_at ASC")
  ]);
  const roomsByProject = new Map();
  roomsResult.rows.forEach((room) => {
    const rooms = roomsByProject.get(room.project_id) || [];
    rooms.push(room);
    roomsByProject.set(room.project_id, rooms);
  });
  res.json({
    pendingUsers: usersResult.rows,
    projects: projectsResult.rows.map((project) => ({
      ...project,
      rooms: roomsByProject.get(project.id) || []
    }))
  });
}));

app.get("/api/admin/users", requireAdmin, asyncHandler(async (_req, res) => {
  const [usersResult, projectMembershipsResult, roomMembershipsResult] = await Promise.all([
    query(
      `SELECT id, name, email, approval_status, is_admin, created_at
       FROM users ORDER BY is_admin DESC, name ASC, email ASC`
    ),
    query(
      `SELECT pm.user_id, pm.project_id, p.name AS project_name, pm.role, pm.access_scope
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       ORDER BY p.name ASC`
    ),
    query(
      `SELECT rm.user_id, rm.room_id, r.name AS room_name, r.project_id,
              p.name AS project_name, rm.role
       FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
       JOIN projects p ON p.id = r.project_id
       ORDER BY p.name ASC, r.name ASC`
    )
  ]);
  const projectsByUser = new Map();
  projectMembershipsResult.rows.forEach((membership) => {
    const memberships = projectsByUser.get(membership.user_id) || [];
    memberships.push(membership);
    projectsByUser.set(membership.user_id, memberships);
  });
  const roomsByUser = new Map();
  roomMembershipsResult.rows.forEach((membership) => {
    const memberships = roomsByUser.get(membership.user_id) || [];
    memberships.push(membership);
    roomsByUser.set(membership.user_id, memberships);
  });
  res.json({
    users: usersResult.rows.map((user) => ({
      ...user,
      projects: projectsByUser.get(user.id) || [],
      rooms: roomsByUser.get(user.id) || []
    }))
  });
}));

app.post("/api/admin/users/:userId/approve", requireAdmin, asyncHandler(async (req, res) => {
  const projectId = text(req.body.projectId, 100);
  const role = req.body.role === "readonly" ? "readonly" : "full";
  if (!projectId) return res.status(400).json({ error: "Choose a project before approving this user." });
  const result = await assignUserAccess({ userId: req.params.userId, projectId, roomId: null, role });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}));

app.post("/api/admin/users/:userId/assign", requireAdmin, asyncHandler(async (req, res) => {
  const projectId = text(req.body.projectId, 100);
  const roomId = text(req.body.roomId, 100) || null;
  const role = req.body.role === "readonly" ? "readonly" : "full";
  if (!projectId) return res.status(400).json({ error: "Choose a project or subproject." });
  const result = await assignUserAccess({ userId: req.params.userId, projectId, roomId, role });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}));

app.delete("/api/admin/users/:userId/projects/:projectId", requireAdmin, asyncHandler(async (req, res) => {
  const user = await getManageableUser(req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.is_admin) return res.status(400).json({ error: "The global administrator cannot be removed from a project." });

  const removed = await transaction(async (client) => {
    await client.query(
      `DELETE FROM room_members
       WHERE user_id = $1 AND room_id IN (SELECT id FROM rooms WHERE project_id = $2)`,
      [user.id, req.params.projectId]
    );
    return client.query(
      "DELETE FROM project_members WHERE user_id = $1 AND project_id = $2 RETURNING project_id",
      [user.id, req.params.projectId]
    );
  });
  if (!removed.rows[0]) return res.status(404).json({ error: "This user is not assigned to that project." });
  res.json({ ok: true });
}));

app.delete("/api/admin/users/:userId/rooms/:roomId", requireAdmin, asyncHandler(async (req, res) => {
  const [user, roomResult] = await Promise.all([
    getManageableUser(req.params.userId),
    query("SELECT id, project_id FROM rooms WHERE id = $1", [req.params.roomId])
  ]);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.is_admin) return res.status(400).json({ error: "The global administrator cannot be removed from a subproject." });
  const room = roomResult.rows[0];
  if (!room) return res.status(404).json({ error: "Subproject chat not found." });

  const removed = await transaction(async (client) => {
    const deletion = await client.query(
      "DELETE FROM room_members WHERE user_id = $1 AND room_id = $2 RETURNING room_id",
      [user.id, room.id]
    );
    if (!deletion.rows[0]) return deletion;
    const projectMembership = await getProjectMembership(room.project_id, user.id, client);
    if (projectMembership?.access_scope === "container") {
      const remaining = await client.query(
        `SELECT 1 FROM room_members rm
         JOIN rooms r ON r.id = rm.room_id
         WHERE rm.user_id = $1 AND r.project_id = $2 LIMIT 1`,
        [user.id, room.project_id]
      );
      if (!remaining.rows[0]) {
        await client.query(
          "DELETE FROM project_members WHERE user_id = $1 AND project_id = $2",
          [user.id, room.project_id]
        );
      }
    }
    return deletion;
  });
  if (!removed.rows[0]) return res.status(404).json({ error: "This user is not assigned to that subproject." });
  res.json({ ok: true });
}));

app.delete("/api/projects/:projectId", requireAdmin, asyncHandler(async (req, res) => {
  const result = await query("DELETE FROM projects WHERE id = $1 RETURNING id", [req.params.projectId]);
  if (!result.rows[0]) return res.status(404).json({ error: "Project not found." });
  res.json({ ok: true });
}));

app.delete("/api/rooms/:roomId", requireAdmin, asyncHandler(async (req, res) => {
  const result = await query("DELETE FROM rooms WHERE id = $1 RETURNING id", [req.params.roomId]);
  if (!result.rows[0]) return res.status(404).json({ error: "Subproject chat not found." });
  res.json({ ok: true });
}));

app.get("/api/rooms/:roomId", requireAuth, requireRoomMembership, asyncHandler(async (req, res) => {
  res.json(await roomDetails(req.params.roomId, req.user.id));
}));

app.post("/api/projects", requireAdmin, asyncHandler(async (req, res) => {
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

app.post("/api/projects/:projectId/rooms", requireAdmin, asyncHandler(async (req, res) => {
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
       SELECT $1, user_id, role, $2::timestamptz
       FROM project_members WHERE project_id = $3 AND access_scope = 'project'`,
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

app.post("/api/invites", requireAdmin, asyncHandler(async (req, res) => {
  const projectId = text(req.body.projectId, 100);
  const roomId = text(req.body.roomId, 100) || null;
  const email = normalizedEmail(req.body.email);
  const role = req.body.role === "readonly" ? "readonly" : "full";
  if (!projectId || !email) return res.status(400).json({ error: "Project, email, and role are required." });

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

app.post("/api/invites/:token/accept", requireSignedIn, asyncHandler(async (req, res) => {
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
    await client.query(
      "UPDATE users SET approval_status = 'approved' WHERE id = $1",
      [req.user.id]
    );
    const projectRole = invite.room_id ? "readonly" : invite.role;
    const accessScope = invite.room_id ? "container" : "project";
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, access_scope, added_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, user_id) DO UPDATE
       SET access_scope = CASE
             WHEN project_members.access_scope = 'project' OR EXCLUDED.access_scope = 'project' THEN 'project'
             ELSE 'container'
           END,
           role = CASE
             WHEN EXCLUDED.access_scope = 'project' THEN EXCLUDED.role
             WHEN project_members.access_scope = 'project' THEN project_members.role
             ELSE 'readonly'
           END`,
      [invite.project_id, req.user.id, projectRole, accessScope, nowIso()]
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

app.delete("/api/tasks/:taskId", requireAdmin, asyncHandler(async (req, res) => {
  const result = await query("DELETE FROM tasks WHERE id = $1 RETURNING id", [req.params.taskId]);
  if (!result.rows[0]) return res.status(404).json({ error: "Task not found." });
  res.json({ ok: true });
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
