const state = {
  user: null,
  workspace: [],
  currentRoomId: null,
  currentRoom: null,
  pendingInvites: [],
  authMode: "login",
  modal: null,
  chatSearch: "",
  mainView: "chat",
  inviteToken: new URLSearchParams(window.location.search).get("invite"),
  inviteNotice: "",
  lastInviteUrl: "",
  pendingApprovalCount: 0,
  adminOverview: null,
  adminNotice: "",
  notifications: [],
  unreadNotificationCount: 0,
  editingMessageId: null,
  mobileView: "list"
};

const app = document.querySelector("#app");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateLine(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDateLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = date.toLocaleDateString();
  if (key === today.toLocaleDateString()) return "Today";
  if (key === yesterday.toLocaleDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {})
  });
}

function dateGroupedHtml(items, getDate, renderItem) {
  let previousDate = "";
  return items.map((item) => {
    const iso = getDate(item);
    const dateKey = new Date(iso).toLocaleDateString();
    const divider = dateKey !== previousDate
      ? `<div class="date-divider"><span>${escapeHtml(formatDateLabel(iso))}</span></div>`
      : "";
    previousDate = dateKey;
    return `${divider}${renderItem(item)}`;
  }).join("");
}

function icon(name) {
  const paths = {
    back: '<path d="M15 18l-6-6 6-6"/><path d="M9 12h10"/>',
    bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    check: '<path d="M5 12l4 4L19 6"/>',
    details: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/>',
    logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 4h5v16h-5"/>',
    menu: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 11a8 8 0 10-2 5.5"/><path d="M20 4v7h-7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/>',
    users: '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

function queuePaneScroll() {
  window.requestAnimationFrame(() => {
    const stream = document.querySelector(".message-stream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

function initials(value) {
  return String(value || "")
    .split(" ")
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function flatRooms() {
  return state.workspace.flatMap((project) =>
    project.rooms
      .filter((room) => room.room_type === "subproject")
      .map((room) => ({
        ...room,
        projectName: project.name,
        projectId: project.id,
        projectRole: project.role
      }))
  );
}

function currentRoomMeta() {
  return flatRooms().find((room) => room.id === state.currentRoomId) || null;
}

function setRoomUnread(roomId, count) {
  state.workspace.forEach((project) => {
    project.rooms.forEach((room) => {
      if (room.id === roomId) room.unreadCount = count;
    });
  });
}

function setRoomActivity(roomId, lastActivityAt) {
  state.workspace.forEach((project) => {
    project.rooms.forEach((room) => {
      if (room.id === roomId && lastActivityAt) room.lastActivityAt = lastActivityAt;
    });
  });
}

function activityTime(record) {
  return new Date(record.lastActivityAt || record.lastMessage?.created_at || record.created_at || 0).getTime();
}

function sidebarProjectGroups() {
  const search = state.chatSearch.trim().toLowerCase();
  return state.workspace.map((project) => {
    const subprojects = project.rooms
      .filter((room) => {
        if (room.room_type !== "subproject") return false;
        if (!search || project.name.toLowerCase().includes(search)) return true;
        return room.name.toLowerCase().includes(search);
      })
      .sort((a, b) => activityTime(b) - activityTime(a));
    return {
      ...project,
      subprojects,
      latestActivity: subprojects[0] ? activityTime(subprojects[0]) : activityTime(project)
    };
  })
    .filter((project) => !search || project.name.toLowerCase().includes(search) || project.subprojects.length)
    .sort((a, b) => b.latestActivity - a.latestActivity);
}

function chatListHtml() {
  const projectGroups = sidebarProjectGroups();
  return projectGroups.length ? projectGroups.map((project) => `
    <section class="project-group">
      <div class="project-label">${escapeHtml(project.name)}</div>
      <div class="subproject-list">
        ${project.subprojects.map((room) => `
          <button class="chat-item ${room.id === state.currentRoomId ? "active" : ""} ${room.unreadCount ? "has-unread" : ""}" data-action="open-room" data-room-id="${escapeHtml(room.id)}" type="button" aria-label="${escapeHtml(room.name)}${room.unreadCount ? `, ${room.unreadCount} unread` : ""}">
            <span class="chat-list-avatar">${escapeHtml(initials(room.name))}</span>
            <span class="chat-list-copy">
              <span class="chat-title">${escapeHtml(room.name)}</span>
            </span>
            <span class="chat-list-end">
              <span class="unread-badge" data-unread-room="${escapeHtml(room.id)}" title="${room.unreadCount ? `${room.unreadCount} unread message${room.unreadCount === 1 ? "" : "s"}` : ""}">${room.unreadCount ? escapeHtml(room.unreadCount) : ""}</span>
            </span>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("") : `<div class="sidebar-empty">No subprojects found</div>`;
}

async function bootstrap() {
  const me = await api("/api/me");
  state.user = me.user;
  if (!state.user) {
    render();
    return;
  }

  if (state.inviteToken) {
    try {
      await api(`/api/invites/${state.inviteToken}/accept`, { method: "POST" });
      state.inviteNotice = "Invitation accepted. Welcome to the project.";
      state.user = (await api("/api/me")).user;
    } catch (error) {
      state.inviteNotice = error.message;
    } finally {
      state.inviteToken = null;
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  if (state.user.approval_status !== "approved") {
    state.workspace = [];
    state.currentRoom = null;
    state.currentRoomId = null;
    render();
    return;
  }

  const data = await api("/api/bootstrap");
  state.user = data.user;
  state.workspace = data.workspace;
  state.pendingInvites = data.pendingInvites;
  state.pendingApprovalCount = data.pendingApprovalCount || 0;
  state.unreadNotificationCount = data.unreadNotificationCount || 0;

  const rooms = flatRooms();
  if (!rooms.length) {
    state.currentRoomId = null;
    state.currentRoom = null;
    render();
    return;
  }

  if (!rooms.some((room) => room.id === state.currentRoomId)) {
    state.currentRoomId = rooms[0].id;
  }

  state.currentRoom = await api(`/api/rooms/${state.currentRoomId}`);
  render();
}

function pendingApprovalView() {
  return `
    <div class="auth-shell">
      <section class="pending-card">
        <div class="brand-badge">PC</div>
        <div>
          <span class="hero-badge">Approval pending</span>
          <h2>Your account is ready.</h2>
          <p class="hero-copy">The administrator must approve ${escapeHtml(state.user.email)} and assign it to a project before the workspace opens.</p>
        </div>
        ${state.inviteNotice ? `<p class="error">${escapeHtml(state.inviteNotice)}</p>` : ""}
        <div class="pending-actions">
          <button class="pill-button" data-action="retry-approval" type="button">Check approval</button>
          <button class="ghost-button" data-action="logout" type="button">Sign out</button>
        </div>
      </section>
    </div>
  `;
}

async function loadRoom(roomId) {
  state.currentRoomId = roomId;
  state.currentRoom = await api(`/api/rooms/${roomId}`);
  state.editingMessageId = null;
  setRoomUnread(roomId, 0);
  state.mainView = "chat";
  state.mobileView = "room";
  render();
  queuePaneScroll();
}

function countdownText(dueAt, status) {
  if (!dueAt) return "";
  if (status === "done") return `Completed / deadline ${new Date(dueAt).toLocaleString()}`;
  const remaining = new Date(dueAt).getTime() - Date.now();
  const absolute = Math.abs(remaining);
  const days = Math.floor(absolute / 86400000);
  const hours = Math.floor((absolute % 86400000) / 3600000);
  const minutes = Math.floor((absolute % 3600000) / 60000);
  const seconds = Math.floor((absolute % 60000) / 1000);
  const value = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
  return remaining >= 0 ? `Due in ${value}` : `Overdue by ${value}`;
}

function updateCountdowns() {
  document.querySelectorAll("[data-task-due]").forEach((element) => {
    element.textContent = countdownText(element.dataset.taskDue, element.dataset.taskStatus);
    element.classList.toggle("overdue", element.dataset.taskStatus !== "done" && new Date(element.dataset.taskDue).getTime() < Date.now());
  });
}

async function pollActivity() {
  if (!state.user || state.user.approval_status !== "approved") return;
  try {
    const activity = await api("/api/activity");
    state.unreadNotificationCount = activity.unreadNotificationCount;
    const counts = new Map(activity.rooms.map((room) => [room.roomId, room.unreadCount]));
    activity.rooms.forEach((room) => {
      setRoomUnread(room.roomId, room.unreadCount);
      setRoomActivity(room.roomId, room.lastActivityAt);
    });
    const chatList = document.querySelector(".chat-list");
    if (chatList) chatList.innerHTML = chatListHtml();
    const notificationBadge = document.querySelector("[data-notification-count]");
    if (notificationBadge) notificationBadge.textContent = activity.unreadNotificationCount ? String(activity.unreadNotificationCount) : "";
  } catch (_error) {
    // A later poll will recover after temporary network or deployment interruptions.
  }
}

function openModal(type) {
  state.modal = type;
  render();
}

async function loadAdminOverview() {
  if (!state.user?.is_admin) return;
  const [overview, directory] = await Promise.all([
    api("/api/admin/overview"),
    api("/api/admin/users")
  ]);
  state.adminOverview = { ...overview, users: directory.users };
}

async function refreshAdminWorkspace(message) {
  state.adminNotice = message;
  await bootstrap();
  await loadAdminOverview();
  state.modal = "workspace";
  render();
}

async function loadNotifications() {
  const result = await api("/api/notifications");
  state.notifications = result.notifications;
}

function closeModal() {
  state.modal = null;
  render();
}

function authView() {
  const isLogin = state.authMode === "login";
  return `
    <div class="auth-shell">
      <section class="auth-card">
        <div class="auth-hero">
          <div>
            <span class="hero-badge">Chat-first project management</span>
            <h1>WhatsApp-style collaboration for teams, projects, and subprojects.</h1>
            <p class="hero-copy">
              Keep every project in a familiar conversation flow, then branch into subprojects without losing ownership, tasks, or permission control.
            </p>
          </div>
          <div class="hero-grid">
            <article class="hero-stat">
              <strong>Projects</strong>
              <span>Clean containers for focused subproject conversations.</span>
            </article>
            <article class="hero-stat">
              <strong>Access</strong>
              <span>Full-access and read-only permissions built into the room.</span>
            </article>
            <article class="hero-stat">
              <strong>Tasks</strong>
              <span>Create, assign, and update tasks without leaving the chat.</span>
            </article>
          </div>
        </div>
        <div class="auth-panel">
          <div>
            <h2>${isLogin ? "Welcome back" : "Create your workspace account"}</h2>
            <p class="hint">${isLogin ? "Sign in to continue." : "Create an account and start building your workspace."}</p>
          </div>
          <div class="auth-tabs">
            <button class="auth-tab ${isLogin ? "active" : ""}" data-action="set-auth-mode" data-mode="login" type="button">Login</button>
            <button class="auth-tab ${!isLogin ? "active" : ""}" data-action="set-auth-mode" data-mode="register" type="button">Create account</button>
          </div>
          <form class="auth-form" data-action="auth-submit">
            ${!isLogin ? `<input name="name" placeholder="Your full name" required>` : ""}
            <input name="email" type="email" placeholder="Work email" required>
            <input name="password" type="password" minlength="8" placeholder="Password (8+ characters)" required>
            <button class="pill-button" type="submit">${isLogin ? "Enter workspace" : "Create account"}</button>
          </form>
          ${state.inviteToken ? `<p class="hint">Sign in or create an account with the email address that received this invitation.</p>` : ""}
          <p id="auth-feedback" class="error"></p>
        </div>
      </section>
    </div>
  `;
}

function inviteListHtml() {
  return state.pendingInvites.map((invite) => `
    <article class="invite-card compact">
      <div>
        <strong>${escapeHtml(invite.project_name)}</strong>
        <p class="chat-preview">${escapeHtml(invite.room_name || "Entire project")}</p>
      </div>
      <div class="invite-row">
        <span class="invite-role">${escapeHtml(invite.role)}</span>
        <button class="invite-accept" data-action="accept-invite" data-token="${escapeHtml(invite.token)}" type="button">Accept</button>
      </div>
    </article>
  `).join("");
}

function sidebarHtml() {
  return `
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="workspace-head">
          <div class="brand">
            <div class="brand-badge">${escapeHtml(initials(state.user.name))}</div>
            <div>
              <div class="workspace-title">ProjectChat</div>
              <p class="meta-line">${escapeHtml(state.user.name)}${state.user.is_admin ? " / admin" : ""}</p>
            </div>
          </div>
          <div class="sidebar-icon-row">
            <button class="icon-button notification-button" data-action="open-modal" data-modal="notifications" type="button" title="Notifications" aria-label="Notifications">
              ${icon("bell")}
              <span class="icon-count" data-notification-count>${state.unreadNotificationCount || ""}</span>
            </button>
            ${state.user.is_admin ? `<button class="icon-button" data-action="open-modal" data-modal="project" type="button" title="New project" aria-label="New project">${icon("plus")}</button>` : ""}
            ${state.user.is_admin || state.pendingInvites.length ? `
              <button class="icon-button notification-button" data-action="open-modal" data-modal="workspace" type="button" title="${state.user.is_admin ? "Admin workspace" : "Invitations"}" aria-label="${state.user.is_admin ? "Admin workspace" : "Invitations"}">
                ${icon("users")}
                <span class="icon-count">${state.user.is_admin ? (state.pendingApprovalCount || "") : state.pendingInvites.length}</span>
              </button>
            ` : ""}
            <button class="icon-button" data-action="logout" type="button" title="Logout" aria-label="Logout">${icon("logout")}</button>
          </div>
        </div>
        <div class="search-wrap">
          ${icon("search")}
          <input class="search-input" id="chat-search" value="${escapeHtml(state.chatSearch)}" placeholder="Search projects and chats">
        </div>
      </div>
      ${state.pendingInvites.length ? `
        <div class="sidebar-inline-note">
          <button class="inline-note-button" data-action="open-modal" data-modal="workspace" type="button">
            ${state.pendingInvites.length} pending invite${state.pendingInvites.length === 1 ? "" : "s"}
          </button>
        </div>
      ` : ""}
      ${state.inviteNotice ? `<div class="sidebar-notice">${escapeHtml(state.inviteNotice)}</div>` : ""}
      <div class="chat-list">
        ${chatListHtml()}
      </div>
    </aside>
  `;
}

function messageHtml(message) {
  const self = message.author_id === state.user.id;
  const canDelete = self || state.user.is_admin;
  const inlineTask = message.kind === "task" && Boolean(message.task_status);
  const canCompleteTask = inlineTask && state.currentRoom.membership.role === "full";
  const taskDone = inlineTask && message.task_status === "done";
  const editing = self && state.editingMessageId === message.id;
  const readByOthers = (message.readBy || []).filter((reader) => reader.id !== state.user.id);
  return `
    <article class="message-row ${self ? "self" : ""}">
      <div class="message-bubble ${taskDone ? "task-done" : ""}">
        ${!self || message.kind !== "update" ? `<div class="message-meta">
          ${!self ? `<strong>${escapeHtml(message.author_name)}</strong>` : ""}
          ${message.kind !== "update" ? `<span class="message-label ${escapeHtml(message.kind)}">${escapeHtml(message.kind)}</span>` : ""}
        </div>` : ""}
        ${editing ? `
          <form class="message-edit-form" data-action="edit-message" data-message-id="${escapeHtml(message.id)}">
            <input name="text" value="${escapeHtml(message.text)}" maxlength="5000" required>
            <button type="submit" title="Save">${icon("check")}</button>
            <button data-action="cancel-edit-message" type="button">Cancel</button>
          </form>
        ` : `<p class="message-text">${escapeHtml(message.text)}</p>`}
        ${!editing && message.mentions.length ? `<div class="message-tags">${message.mentions.map((mention) => `<span>@${escapeHtml(mention.name)}</span>`).join("")}</div>` : ""}
        ${!editing ? `
          <div class="message-foot">
            <div class="message-actions">
              ${inlineTask ? (taskDone
                ? `<span class="chat-task-complete">${icon("check")} Done</span>`
                : canCompleteTask ? `<button class="message-done-button" data-action="complete-chat-task" data-message-id="${escapeHtml(message.id)}" type="button">${icon("check")} Done</button>` : "") : ""}
              ${self ? `<button data-action="start-edit-message" data-message-id="${escapeHtml(message.id)}" type="button" title="Edit message" aria-label="Edit message">${icon("edit")}</button>` : ""}
              ${canDelete ? `<button class="delete-message-button" data-action="delete-message" data-message-id="${escapeHtml(message.id)}" type="button" title="Delete message" aria-label="Delete message">${icon("trash")}</button>` : ""}
            </div>
            <span class="message-time">
              ${message.edited_at ? "edited · " : ""}${formatTime(message.created_at)}
              ${self ? `<span class="read-receipt" title="${escapeHtml(readByOthers.map((reader) => reader.name).join(", ") || "Not read by teammates yet")}">${readByOthers.length ? "✓✓" : "✓"}</span>` : ""}
            </span>
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function taskMessageHtml(task, disabled) {
  const done = task.status === "done";
  const latestUpdate = task.updates?.[0];
  return `
    <article class="task-message ${done ? "done" : ""}">
      <button class="task-check" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" data-status="${done ? "open" : "done"}" type="button" ${disabled ? "disabled" : ""} aria-label="${done ? "Mark task not done" : "Mark task done"}" title="${done ? "Mark not done" : "Mark done"}">
        ${done ? icon("check") : ""}
      </button>
      <div class="task-message-body">
        <div class="task-message-head">
          <strong class="task-title">${escapeHtml(task.title)}</strong>
          <time>${formatTime(task.created_at)}</time>
        </div>
        ${task.note ? `<p class="task-note">${escapeHtml(task.note)}</p>` : ""}
        <div class="task-message-meta">
          <span>Assigned to ${escapeHtml(task.assignee_name)}</span>
          <span class="task-state ${done ? "done" : "open"}">${done ? "Done" : "Open"}</span>
          ${task.due_at ? `<span class="task-countdown" data-task-due="${escapeHtml(task.due_at)}" data-task-status="${escapeHtml(task.status)}">${escapeHtml(countdownText(task.due_at, task.status))}</span>` : ""}
        </div>
        ${latestUpdate ? `<div class="task-latest"><strong>${escapeHtml(latestUpdate.author_name)}</strong> ${escapeHtml(latestUpdate.text)}</div>` : ""}
        ${!disabled ? `
          <div class="task-actions">
            <input class="task-status-input" id="task-update-${escapeHtml(task.id)}" placeholder="Reply with a status update">
            <button class="save-status-button" data-action="task-update" data-task-id="${escapeHtml(task.id)}" type="button" aria-label="Send status update">${icon("send")}</button>
            ${state.user.is_admin ? `<button class="task-delete-button" data-action="delete-task" data-task-id="${escapeHtml(task.id)}" type="button" aria-label="Delete task" title="Delete task">${icon("trash")}</button>` : ""}
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function mainHtml() {
  if (!state.currentRoom) {
    return `
      <main class="main">
        <div class="welcome-state">
          <div class="welcome-mark">PC</div>
          <h2>Project conversations, kept simple.</h2>
          <p>Select a subproject to open its chat and tasks.</p>
        </div>
      </main>
    `;
  }

  const room = state.currentRoom.room;
  const disabled = state.currentRoom.membership.role !== "full";
  const openTasks = state.currentRoom.tasks.filter((task) => task.status === "open").length;
  const doneTasks = state.currentRoom.tasks.filter((task) => task.status === "done").length;

  return `
    <main class="main">
      <header class="chat-header">
        <div class="chat-head-main">
          <button class="mobile-back-button" data-action="back-to-list" type="button" aria-label="Back to projects">${icon("back")}</button>
          <div class="chat-avatar">${escapeHtml(initials(room.name))}</div>
          <div class="chat-heading">
            <h2>${escapeHtml(room.name)}</h2>
            <p class="room-subtitle">${escapeHtml(room.projectName)} · ${state.currentRoom.members.length} member${state.currentRoom.members.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div class="header-actions">
          <nav class="view-tabs" aria-label="Room views">
            <button class="view-tab ${state.mainView === "chat" ? "is-active" : ""}" data-action="set-main-view" data-view="chat" type="button">Chat</button>
            <button class="view-tab ${state.mainView === "tasks" ? "is-active" : ""}" data-action="set-main-view" data-view="tasks" type="button">Tasks${openTasks ? `<span>${openTasks}</span>` : ""}</button>
          </nav>
          <button class="icon-button" data-action="open-modal" data-modal="details" type="button" title="Project details" aria-label="Project details">${icon("details")}</button>
          <button class="icon-button refresh-button" data-action="refresh-room" type="button" title="Refresh chat" aria-label="Refresh chat">${icon("refresh")}</button>
        </div>
      </header>

      <section class="message-stream">
        ${state.mainView === "chat" ? `
          <div class="message-list">
            ${state.currentRoom.messages.length ? dateGroupedHtml(state.currentRoom.messages, (message) => message.created_at, messageHtml) : `<div class="conversation-empty"><strong>No messages yet</strong><span>Start the conversation below.</span></div>`}
          </div>
        ` : `
          <div class="tasks-screen-head">
            <span>${openTasks} open</span>
            <span>${doneTasks} done</span>
          </div>
          <div class="task-conversation">
            ${state.currentRoom.tasks.length
              ? dateGroupedHtml([...state.currentRoom.tasks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)), (task) => task.created_at, (task) => taskMessageHtml(task, disabled))
              : `<div class="conversation-empty"><strong>No tasks yet</strong><span>Create one below and keep work visible.</span></div>`}
          </div>
        `}
      </section>

      <section class="composer-panel">
        ${state.mainView === "chat" ? `
          <form class="message-form" data-action="send-message">
            <select class="composer-kind" name="kind" title="Message type" ${disabled ? "disabled" : ""}>
              <option value="update">Update</option>
              <option value="task">Task</option>
              <option value="alert">Alert</option>
            </select>
            <select class="composer-mention" name="mentionId" title="Mention a member" aria-label="Mention a member" ${disabled ? "disabled" : ""}>
              <option value="">@</option>
              ${state.currentRoom.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("")}
            </select>
            <input name="text" autocomplete="off" placeholder="${disabled ? "This room is read only for you" : "Type a message"}" ${disabled ? "disabled" : ""} required>
            <button class="send-button" type="submit" ${disabled ? "disabled" : ""} aria-label="Send message">${icon("send")}</button>
          </form>
        ` : `
          <form class="task-composer" data-action="create-task">
            <div class="task-compose-row">
              <input name="title" autocomplete="off" placeholder="${disabled ? "This room is read only for you" : "Add a task"}" ${disabled ? "disabled" : ""} required>
              <select name="assigneeId" title="Assign to" ${disabled ? "disabled" : ""}>
                ${state.currentRoom.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("")}
              </select>
              <button class="send-button" type="submit" ${disabled ? "disabled" : ""} aria-label="Create task">${icon("plus")}</button>
            </div>
            <details class="task-compose-more">
              <summary>Note and deadline</summary>
              <div>
                <input name="dueAt" type="datetime-local" title="Task deadline" ${disabled ? "disabled" : ""}>
                <input name="note" placeholder="Optional note" ${disabled ? "disabled" : ""}>
              </div>
            </details>
          </form>
        `}
      </section>
    </main>
  `;
}

function detailsModalHtml() {
  if (!state.currentRoom) return "";
  const { room, members, membership, tasks } = state.currentRoom;
  return `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <div>
            <h3>${escapeHtml(room.name)}</h3>
            <p class="modal-subtitle">${escapeHtml(room.projectName)} / ${escapeHtml(room.roomType)}</p>
          </div>
          <button class="ghost-button" data-action="close-modal" type="button">Close</button>
        </div>
        <div class="details-grid">
          <article class="detail-card">
            <strong>Room access</strong>
            <p class="meta-line">${escapeHtml(membership.role)} access</p>
            <p class="meta-line">${tasks.filter((task) => task.status === "open").length} open tasks / ${tasks.filter((task) => task.status === "done").length} done</p>
          </article>
          <article class="detail-card">
            <strong>Description</strong>
            <p class="meta-line">${escapeHtml(room.description || room.projectDescription || "No description yet.")}</p>
          </article>
        </div>
        <div class="modal-section">
          <strong>Members</strong>
          <div class="member-list-modal">
            ${members.map((member) => `
              <div class="member-row">
                <div class="member-row-left">
                  <span class="member-avatar">${escapeHtml(initials(member.name))}</span>
                  <div>
                    <strong>${escapeHtml(member.name)}</strong>
                    <p class="meta-line">${escapeHtml(member.email)}</p>
                  </div>
                </div>
                <span class="chat-role ${member.role === "full" ? "full" : "readonly"}">${escapeHtml(member.role)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function tasksModalHtml() {
  if (!state.currentRoom) return "";
  const disabled = state.currentRoom.membership.role !== "full";
  const tasks = state.currentRoom.tasks || [];
  return `
    <div class="modal-backdrop">
      <div class="modal modal-wide">
        <div class="modal-head">
          <div>
            <h3>Tasks</h3>
            <p class="modal-subtitle">${escapeHtml(state.currentRoom.room.name)} task board</p>
          </div>
          <button class="ghost-button" data-action="close-modal" type="button">Close</button>
        </div>
        <form class="task-form" data-action="create-task">
          <input name="title" placeholder="Task title" ${disabled ? "disabled" : ""} required>
          <select name="assigneeId" ${disabled ? "disabled" : ""}>
            ${state.currentRoom.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("")}
          </select>
          <input name="dueAt" type="datetime-local" title="Task deadline" ${disabled ? "disabled" : ""}>
          <textarea name="note" rows="2" placeholder="Short task note" ${disabled ? "disabled" : ""}></textarea>
          <button class="pill-button" type="submit" ${disabled ? "disabled" : ""}>Create task</button>
        </form>
        <div class="tasks-grid">
          ${tasks.length ? tasks.map((task) => `
            <article class="task-card ${task.status === "done" ? "done" : ""}">
              <div class="task-card-top">
                <strong class="task-title">${escapeHtml(task.title)}</strong>
                <div class="task-card-controls">
                  <button class="task-toggle" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" data-status="${task.status === "open" ? "done" : "open"}" type="button">
                    ${task.status === "open" ? "Mark done" : "Re-open"}
                  </button>
                  ${state.user.is_admin ? `<button class="danger-link" data-action="delete-task" data-task-id="${escapeHtml(task.id)}" type="button">Delete</button>` : ""}
                </div>
              </div>
              <p>${escapeHtml(task.note)}</p>
              <p class="task-meta">Assigned to ${escapeHtml(task.assignee_name)} / ${escapeHtml(task.status)}</p>
              ${task.due_at ? `<p class="task-countdown" data-task-due="${escapeHtml(task.due_at)}" data-task-status="${escapeHtml(task.status)}">${escapeHtml(countdownText(task.due_at, task.status))}</p>` : ""}
              <div class="task-actions">
                <input class="task-status-input" id="task-update-${escapeHtml(task.id)}" placeholder="Write status update" ${disabled ? "disabled" : ""}>
                <button class="save-status-button" data-action="task-update" data-task-id="${escapeHtml(task.id)}" type="button" ${disabled ? "disabled" : ""}>Save</button>
              </div>
              <p class="hint">${task.updates[0] ? `Latest: ${escapeHtml(task.updates[0].text)} by ${escapeHtml(task.updates[0].author_name)}` : "No status updates yet."}</p>
            </article>
          `).join("") : `<div class="empty-state">No tasks in this room yet.</div>`}
        </div>
      </div>
    </div>
  `;
}

function memberDirectoryHtml(users, projects) {
  return `
    <div class="member-directory">
      ${users.map((user) => `
        <article class="directory-member-card">
          <div class="directory-member-head">
            <div>
              <strong>${escapeHtml(user.name || "Unnamed member")}</strong>
              <p class="meta-line">${escapeHtml(user.email)}</p>
            </div>
            <div class="directory-badges">
              <span class="status-badge ${escapeHtml(user.approval_status)}">${escapeHtml(user.approval_status)}</span>
              ${user.is_admin ? `<span class="admin-badge">Global admin</span>` : ""}
            </div>
          </div>
          <div class="membership-list">
            ${user.projects.map((membership) => `
              <span class="membership-chip">
                ${escapeHtml(membership.project_name)} / ${escapeHtml(membership.role)}${membership.access_scope === "container" ? " / container" : ""}
                ${user.is_admin ? "" : `<button data-action="remove-project-member" data-user-id="${escapeHtml(user.id)}" data-project-id="${escapeHtml(membership.project_id)}" type="button" title="Remove project access">x</button>`}
              </span>
            `).join("")}
            ${user.rooms.map((membership) => `
              <span class="membership-chip room-chip">
                ${escapeHtml(membership.project_name)} / ${escapeHtml(membership.room_name)} / ${escapeHtml(membership.role)}
                ${user.is_admin ? "" : `<button data-action="remove-room-member" data-user-id="${escapeHtml(user.id)}" data-room-id="${escapeHtml(membership.room_id)}" type="button" title="Remove chat access">x</button>`}
              </span>
            `).join("")}
            ${!user.projects.length && !user.rooms.length ? `<span class="meta-line">No project access</span>` : ""}
          </div>
          ${user.is_admin ? `
            <div class="admin-role-row">
              <p class="meta-line">Global admins have full management access everywhere.</p>
              ${user.is_primary_admin ? `<span class="admin-badge">Protected owner</span>` : `<button class="danger-link" data-action="toggle-admin" data-user-id="${escapeHtml(user.id)}" data-is-admin="false" type="button">Remove admin</button>`}
            </div>
          ` : `
            <div class="directory-member-actions">
              <form class="directory-assign-form" data-action="assign-member" data-user-id="${escapeHtml(user.id)}">
                <select name="target" required ${projects.length ? "" : "disabled"}>
                  ${projects.flatMap((project) => [
                    `<option value="project:${escapeHtml(project.id)}">${escapeHtml(project.name)} / entire project</option>`,
                    ...project.rooms.map((room) => `<option value="room:${escapeHtml(project.id)}:${escapeHtml(room.id)}">${escapeHtml(project.name)} / ${escapeHtml(room.name)}</option>`)
                  ]).join("")}
                </select>
                <select name="role" required>
                  <option value="full">Full access</option>
                  <option value="readonly">Read only</option>
                </select>
                <button class="soft-button" type="submit" ${projects.length ? "" : "disabled"}>${user.approval_status === "pending" ? "Approve and assign" : "Add or update"}</button>
              </form>
              <button class="soft-button admin-promote-button" data-action="toggle-admin" data-user-id="${escapeHtml(user.id)}" data-is-admin="true" type="button">Make admin</button>
            </div>
          `}
        </article>
      `).join("")}
    </div>
  `;
}

function workspaceModalHtml() {
  const isAdmin = state.user.is_admin;
  const projects = isAdmin && state.adminOverview
    ? state.adminOverview.projects
    : state.workspace.filter((project) => project.role === "full");
  const directoryUsers = state.adminOverview?.users || [];
  const subprojectRooms = projects.flatMap((project) =>
    project.rooms
      .filter((room) => room.room_type === "subproject")
      .map((room) => ({ ...room, projectName: project.name }))
  );

  return `
    <div class="modal-backdrop">
      <div class="modal ${isAdmin ? "modal-wide" : ""}">
        <div class="modal-head">
          <div>
            <h3>${isAdmin ? "Admin workspace" : "Invitations"}</h3>
            <p class="modal-subtitle">${isAdmin ? "Approve users, assign projects, and manage the workspace." : "Accept invitations from your administrator."}</p>
          </div>
          <button class="ghost-button" data-action="close-modal" type="button">Close</button>
        </div>

        ${state.pendingInvites.length ? `
          <div class="modal-section">
            <strong>Your pending invitations</strong>
            <div class="pending-invites modal-invites">${inviteListHtml()}</div>
          </div>
        ` : ""}

        ${isAdmin ? `
          <div class="modal-section">
            <div class="section-head">
              <strong>Members</strong>
              <span class="section-meta">${directoryUsers.length} accounts</span>
            </div>
            ${state.adminNotice ? `<div class="admin-notice">${escapeHtml(state.adminNotice)}</div>` : ""}
            ${directoryUsers.length ? memberDirectoryHtml(directoryUsers, projects) : `<div class="mini-empty">No member accounts found.</div>`}
          </div>
        ` : ""}

        ${state.lastInviteUrl ? `
          <div class="invite-share">
            <strong>Invite ready</strong>
            <p class="meta-line">Send this private link to the invited teammate.</p>
            <div class="invite-share-row">
              <input id="invite-share-url" value="${escapeHtml(state.lastInviteUrl)}" readonly>
              <button class="soft-button" data-action="copy-invite" type="button">Copy link</button>
            </div>
          </div>
        ` : ""}

        ${isAdmin ? `<div class="details-grid">
          <article class="detail-card">
            <strong>Create subproject</strong>
            <form class="modal-form" data-action="create-subproject">
              <select name="projectId" required>
                ${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}
              </select>
              <input name="name" placeholder="Subproject name" required>
              <textarea name="description" rows="3" placeholder="Describe the focused work for this room"></textarea>
              <button class="pill-button" type="submit">Create subproject</button>
            </form>
          </article>
          <article class="detail-card">
            <strong>Invite member</strong>
            <form class="modal-form" data-action="create-invite">
              <select name="projectId" required>
                ${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}
              </select>
              <select name="roomId">
                <option value="">Entire project</option>
                ${subprojectRooms.map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.projectName)} / ${escapeHtml(room.name)}</option>`).join("")}
              </select>
              <input name="email" type="email" placeholder="Invitee email" required>
              <select name="role" required>
                <option value="full">Full access</option>
                <option value="readonly">Read only</option>
              </select>
              <button class="pill-button" type="submit">Send invite</button>
            </form>
          </article>
        </div>

        <div class="modal-section">
          <strong>Manage projects and chats</strong>
          <div class="admin-project-list">
            ${projects.length ? projects.map((project) => `
              <article class="admin-project-card">
                <div class="admin-project-head">
                  <strong>${escapeHtml(project.name)}</strong>
                  <button class="danger-button" data-action="delete-project" data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}" type="button">Delete project</button>
                </div>
                <div class="admin-room-list">
                  ${project.rooms.length ? project.rooms.map((room) => `
                    <div class="admin-room-row">
                      <span>${escapeHtml(room.name)}</span>
                      <button class="danger-link" data-action="delete-room" data-room-id="${escapeHtml(room.id)}" data-room-name="${escapeHtml(room.name)}" type="button">Delete chat</button>
                    </div>
                  `).join("") : `<span class="meta-line">No subproject chats yet.</span>`}
                </div>
              </article>
            `).join("") : `<div class="mini-empty">Create a project before approving users.</div>`}
          </div>
        </div>` : ""}
      </div>
    </div>
  `;
}

function notificationsModalHtml() {
  return `
    <div class="modal-backdrop">
      <div class="modal notifications-modal">
        <div class="modal-head">
          <div>
            <h3>Notifications</h3>
            <p class="modal-subtitle">Mentions, assigned tasks, access changes, and task updates.</p>
          </div>
          <button class="ghost-button" data-action="close-modal" type="button">Close</button>
        </div>
        <div class="section-head">
          <strong>Recent activity</strong>
          <button class="soft-button" data-action="read-all-notifications" type="button">Mark all read</button>
        </div>
        <div class="notification-list">
          ${state.notifications.length ? state.notifications.map((notification) => `
            <button class="notification-item ${notification.is_read ? "" : "unread"}" data-action="open-notification" data-notification-id="${escapeHtml(notification.id)}" data-room-id="${escapeHtml(notification.room_id || "")}" type="button">
              <span class="notification-type">${escapeHtml(notification.type.replace("_", " "))}</span>
              <strong>${escapeHtml(notification.title)}</strong>
              <span>${escapeHtml(notification.body)}</span>
              <time>${escapeHtml(new Date(notification.created_at).toLocaleString())}</time>
            </button>
          `).join("") : `<div class="mini-empty">No notifications yet.</div>`}
        </div>
      </div>
    </div>
  `;
}

function modalHtml() {
  if (!state.modal || !state.user) return "";

  const projects = state.workspace.filter((project) => project.role === "full");
  const subprojectRooms = projects.flatMap((project) =>
    project.rooms
      .filter((room) => room.room_type === "subproject")
      .map((room) => ({ ...room, projectName: project.name }))
  );

  if (state.modal === "details") return detailsModalHtml();
  if (state.modal === "tasks") return tasksModalHtml();
  if (state.modal === "workspace") return workspaceModalHtml();
  if (state.modal === "notifications") return notificationsModalHtml();

  const bodies = {
    project: `
      <div class="modal-backdrop">
        <div class="modal">
          <div class="modal-head">
            <div>
              <h3>Create project</h3>
              <p class="modal-subtitle">Create a container for related subproject chats.</p>
            </div>
            <button class="ghost-button" data-action="close-modal" type="button">Close</button>
          </div>
          <form class="modal-form" data-action="create-project">
            <input name="name" placeholder="Project name" required>
            <textarea name="description" rows="3" placeholder="Describe the goal and scope"></textarea>
            <button class="pill-button" type="submit">Create project</button>
          </form>
        </div>
      </div>
    `
  };

  return bodies[state.modal] || "";
}

function render() {
  if (!state.user) {
    app.innerHTML = authView();
    return;
  }
  if (state.user.approval_status !== "approved") {
    app.innerHTML = pendingApprovalView();
    return;
  }
  app.innerHTML = `
    <div class="app-shell ${state.mobileView === "room" ? "mobile-room-open" : "mobile-list-open"}">
      ${sidebarHtml()}
      ${mainHtml()}
    </div>
    ${modalHtml()}
  `;
}

document.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;

  const action = actionTarget.dataset.action;

  try {
    if (action === "set-auth-mode") {
      state.authMode = actionTarget.dataset.mode;
      render();
    }

    if (action === "open-room") {
      await loadRoom(actionTarget.dataset.roomId);
    }

    if (action === "back-to-list") {
      state.mobileView = "list";
      render();
    }

    if (action === "set-main-view") {
      state.mainView = actionTarget.dataset.view;
      render();
      queuePaneScroll();
    }

    if (action === "open-modal") {
      if (actionTarget.dataset.modal === "workspace") await loadAdminOverview();
      if (actionTarget.dataset.modal === "notifications") await loadNotifications();
      openModal(actionTarget.dataset.modal);
    }

    if (action === "close-modal") {
      closeModal();
    }

    if (action === "copy-invite") {
      await navigator.clipboard.writeText(state.lastInviteUrl);
      actionTarget.textContent = "Copied";
    }

    if (action === "logout") {
      await api("/api/auth/logout", { method: "POST" });
      state.user = null;
      state.workspace = [];
      state.currentRoom = null;
      state.currentRoomId = null;
      state.adminOverview = null;
      render();
    }

    if (action === "retry-approval") {
      await bootstrap();
    }

    if (action === "delete-project") {
      const confirmed = window.confirm(`Delete "${actionTarget.dataset.projectName}" and every chat, message, and task inside it?`);
      if (!confirmed) return;
      await api(`/api/projects/${actionTarget.dataset.projectId}`, { method: "DELETE" });
      state.modal = null;
      await bootstrap();
    }

    if (action === "delete-room") {
      const confirmed = window.confirm(`Delete the "${actionTarget.dataset.roomName}" chat and all of its messages and tasks?`);
      if (!confirmed) return;
      await api(`/api/rooms/${actionTarget.dataset.roomId}`, { method: "DELETE" });
      state.modal = null;
      await bootstrap();
    }

    if (action === "delete-task") {
      if (!window.confirm("Delete this task permanently?")) return;
      await api(`/api/tasks/${actionTarget.dataset.taskId}`, { method: "DELETE" });
      await bootstrap();
    }

    if (action === "remove-project-member") {
      if (!window.confirm("Remove this member from the entire project?")) return;
      await api(`/api/admin/users/${actionTarget.dataset.userId}/projects/${actionTarget.dataset.projectId}`, { method: "DELETE" });
      await refreshAdminWorkspace("Project access removed. The user account was preserved.");
    }

    if (action === "remove-room-member") {
      if (!window.confirm("Remove this member from this subproject chat?")) return;
      await api(`/api/admin/users/${actionTarget.dataset.userId}/rooms/${actionTarget.dataset.roomId}`, { method: "DELETE" });
      await refreshAdminWorkspace("Subproject access removed.");
    }

    if (action === "toggle-admin") {
      const makeAdmin = actionTarget.dataset.isAdmin === "true";
      if (!makeAdmin && !window.confirm("Remove this user's global administrator privileges?")) return;
      await api(`/api/admin/users/${actionTarget.dataset.userId}/admin`, {
        method: "PATCH",
        body: JSON.stringify({ isAdmin: makeAdmin })
      });
      await refreshAdminWorkspace(makeAdmin ? "Global administrator access granted." : "Global administrator access removed.");
    }

    if (action === "read-all-notifications") {
      await api("/api/notifications/read", { method: "PATCH", body: JSON.stringify({}) });
      state.unreadNotificationCount = 0;
      await loadNotifications();
      render();
    }

    if (action === "open-notification") {
      await api("/api/notifications/read", {
        method: "PATCH",
        body: JSON.stringify({ id: actionTarget.dataset.notificationId })
      });
      state.unreadNotificationCount = Math.max(0, state.unreadNotificationCount - 1);
      if (actionTarget.dataset.roomId) {
        state.modal = null;
        await loadRoom(actionTarget.dataset.roomId);
      } else {
        await loadNotifications();
        render();
      }
    }

    if (action === "accept-invite") {
      await api(`/api/invites/${actionTarget.dataset.token}/accept`, { method: "POST" });
      await bootstrap();
    }

    if (action === "refresh-room" && state.currentRoomId) {
      await loadRoom(state.currentRoomId);
    }

    if (action === "complete-chat-task") {
      await api(`/api/messages/${actionTarget.dataset.messageId}/task-status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" })
      });
      await loadRoom(state.currentRoomId);
    }

    if (action === "start-edit-message") {
      state.editingMessageId = actionTarget.dataset.messageId;
      render();
      document.querySelector(`.message-edit-form[data-message-id="${CSS.escape(state.editingMessageId)}"] input`)?.focus();
    }

    if (action === "cancel-edit-message") {
      state.editingMessageId = null;
      render();
    }

    if (action === "delete-message") {
      if (!window.confirm("Delete this message permanently?")) return;
      await api(`/api/messages/${actionTarget.dataset.messageId}`, { method: "DELETE" });
      await loadRoom(state.currentRoomId);
    }

    if (action === "toggle-task") {
      await api(`/api/tasks/${actionTarget.dataset.taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: actionTarget.dataset.status })
      });
      await bootstrap();
    }

    if (action === "task-update") {
      const input = document.querySelector(`#task-update-${CSS.escape(actionTarget.dataset.taskId)}`);
      await api(`/api/tasks/${actionTarget.dataset.taskId}/updates`, {
        method: "POST",
        body: JSON.stringify({ text: input.value })
      });
      await bootstrap();
    }
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "chat-search") {
    state.chatSearch = event.target.value;
    render();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  const action = form.dataset.action;
  if (!action) return;
  event.preventDefault();

  const formData = new FormData(form);

  try {
    if (action === "auth-submit") {
      const payload = Object.fromEntries(formData.entries());
      const path = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      await api(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await bootstrap();
    }

    if (action === "approve-user") {
      await api(`/api/admin/users/${form.dataset.userId}/approve`, {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      await bootstrap();
      await loadAdminOverview();
      state.modal = "workspace";
      render();
    }

    if (action === "assign-member") {
      const [scope, projectId, roomId] = String(formData.get("target") || "").split(":");
      if (!projectId || !["project", "room"].includes(scope)) throw new Error("Choose a project or subproject.");
      await api(`/api/admin/users/${form.dataset.userId}/assign`, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          roomId: scope === "room" ? roomId : "",
          role: formData.get("role")
        })
      });
      await refreshAdminWorkspace("Member access updated.");
    }

    if (action === "create-project") {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      closeModal();
      await bootstrap();
    }

    if (action === "create-subproject") {
      const payload = Object.fromEntries(formData.entries());
      await api(`/api/projects/${payload.projectId}/rooms`, {
        method: "POST",
        body: JSON.stringify({
          name: payload.name,
          description: payload.description
        })
      });
      closeModal();
      await bootstrap();
    }

    if (action === "create-invite") {
      const result = await api("/api/invites", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      state.lastInviteUrl = result.inviteUrl;
      await bootstrap();
      state.modal = "workspace";
      render();
    }

    if (action === "send-message") {
      const mentionId = formData.get("mentionId");
      await api(`/api/rooms/${state.currentRoomId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          kind: formData.get("kind"),
          text: formData.get("text"),
          mentionIds: mentionId ? [mentionId] : []
        })
      });
      await bootstrap();
      state.mobileView = "room";
      queuePaneScroll();
    }

    if (action === "edit-message") {
      await api(`/api/messages/${form.dataset.messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ text: formData.get("text") })
      });
      state.editingMessageId = null;
      await loadRoom(state.currentRoomId);
    }

    if (action === "create-task") {
      await api(`/api/rooms/${state.currentRoomId}/tasks`, {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      await bootstrap();
      state.modal = null;
      state.mainView = "tasks";
      state.mobileView = "room";
      render();
      queuePaneScroll();
    }
  } catch (error) {
    const feedback = document.querySelector("#auth-feedback");
    if (feedback && action === "auth-submit") {
      feedback.textContent = error.message;
      return;
    }
    alert(error.message);
  }
});

window.setInterval(updateCountdowns, 1000);
window.setInterval(pollActivity, 15000);

bootstrap().catch((error) => {
  app.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-panel">
          <h2>ProjectChat</h2>
          <p class="error">${escapeHtml(error.message)}</p>
        </div>
      </div>
    </div>
  `;
});
