process.env.USE_PGMEM = "1";
process.env.NODE_ENV = "test";
process.env.APP_URL = "http://projectchat.test";
process.env.ADMIN_EMAIL = "owner@example.com";

const request = require("supertest");
const migrate = require("./migrate");
const { pool } = require("../db");

async function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label}: expected ${status}, received ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response;
}

async function register(agent, name, email) {
  return expectStatus(
    await agent.post("/api/auth/register").send({ name, email, password: "strong-password" }),
    200,
    `${name} registration`
  );
}

async function createProject(agent, name) {
  return expectStatus(
    await agent.post("/api/projects").send({ name, description: `${name} description` }),
    200,
    `${name} project creation`
  );
}

async function createRoom(agent, projectId, name) {
  return expectStatus(
    await agent.post(`/api/projects/${projectId}/rooms`).send({ name, description: `${name} work` }),
    200,
    `${name} room creation`
  );
}

async function assign(agent, userId, projectId, role, roomId = "") {
  return expectStatus(
    await agent.post(`/api/admin/users/${userId}/assign`).send({ projectId, roomId, role }),
    200,
    `assign ${userId}`
  );
}

function workspaceProject(bootstrap, projectId) {
  return bootstrap.body.workspace.find((project) => project.id === projectId);
}

async function run() {
  await migrate();
  const app = require("../server");
  const owner = request.agent(app);
  const fullMember = request.agent(app);
  const readonlyMember = request.agent(app);
  const pendingMember = request.agent(app);
  const anonymous = request(app);

  const emptyUsers = await pool.query("SELECT COUNT(*) AS count FROM users");
  if (Number(emptyUsers.rows[0].count) !== 0) throw new Error("fresh migration contained seeded users");
  const home = await owner.get("/");
  await expectStatus(home, 200, "frontend delivery");
  if (!home.text.includes("ProjectChat")) throw new Error("frontend HTML was not delivered");
  await expectStatus(await owner.get("/api/health"), 200, "database health check");

  const ownerRegistration = await register(owner, "Owner", "owner@example.com");
  const ownerId = ownerRegistration.body.user.id;
  if (!ownerRegistration.body.user.is_admin || ownerRegistration.body.user.approval_status !== "approved") {
    throw new Error("configured owner was not made the approved global administrator");
  }

  const projectA = (await createProject(owner, "Project A")).body.projectId;
  const roomA = (await createRoom(owner, projectA, "Room A")).body.roomId;
  const taskResponse = await expectStatus(
    await owner.post(`/api/rooms/${roomA}/tasks`).send({
      title: "Disposable task",
      note: "Verify individual deletion",
      assigneeId: ownerId
    }),
    200,
    "task creation"
  );
  const taskId = taskResponse.body.taskId;
  const updateBeforeDelete = await pool.query("SELECT COUNT(*) AS count FROM task_updates WHERE task_id = $1", [taskId]);
  if (Number(updateBeforeDelete.rows[0].count) !== 1) throw new Error("task update fixture was not created");

  const fullRegistration = await register(fullMember, "Full Member", "full@example.com");
  const readonlyRegistration = await register(readonlyMember, "Read Only", "readonly@example.com");
  const pendingRegistration = await register(pendingMember, "Pending Member", "pending@example.com");
  const fullId = fullRegistration.body.user.id;
  const readonlyId = readonlyRegistration.body.user.id;
  if ([fullRegistration, readonlyRegistration, pendingRegistration].some((result) => result.body.user.approval_status !== "pending")) {
    throw new Error("open signups did not remain pending");
  }
  await expectStatus(await pendingMember.get("/api/bootstrap"), 403, "pending workspace restriction");

  const directory = await expectStatus(await owner.get("/api/admin/users"), 200, "admin member directory");
  if (directory.body.users.length !== 4) throw new Error("admin directory did not list every account");
  if (directory.body.users.some((user) => "password_hash" in user)) throw new Error("admin directory exposed a password hash");
  await expectStatus(await fullMember.get("/api/admin/users"), 403, "non-admin directory restriction");

  await assign(owner, fullId, projectA, "full");
  await assign(owner, readonlyId, projectA, "readonly");
  await expectStatus(
    await fullMember.post(`/api/rooms/${roomA}/messages`).send({ kind: "update", text: "Full access works." }),
    200,
    "full-access write"
  );
  await expectStatus(
    await readonlyMember.post(`/api/rooms/${roomA}/messages`).send({ kind: "update", text: "Blocked." }),
    403,
    "read-only write restriction"
  );

  await expectStatus(await anonymous.delete(`/api/tasks/${taskId}`), 401, "anonymous task deletion restriction");
  await expectStatus(await fullMember.delete(`/api/tasks/${taskId}`), 403, "full-member task deletion restriction");
  await expectStatus(await readonlyMember.delete(`/api/tasks/${taskId}`), 403, "read-only task deletion restriction");
  await expectStatus(await owner.delete(`/api/tasks/${taskId}`), 200, "admin task deletion");
  await expectStatus(await owner.delete(`/api/tasks/${taskId}`), 404, "missing task deletion");
  const [taskAfterDelete, updatesAfterDelete] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM tasks WHERE id = $1", [taskId]),
    pool.query("SELECT COUNT(*) AS count FROM task_updates WHERE task_id = $1", [taskId])
  ]);
  if (Number(taskAfterDelete.rows[0].count) || Number(updatesAfterDelete.rows[0].count)) {
    throw new Error("individual task deletion left task data or orphan updates");
  }

  const projectB = (await createProject(owner, "Project B")).body.projectId;
  const roomB1 = (await createRoom(owner, projectB, "Room B1")).body.roomId;
  const roomB2 = (await createRoom(owner, projectB, "Room B2")).body.roomId;

  await assign(owner, fullId, projectB, "readonly", roomB1);
  await createRoom(owner, projectB, "Room B Unassigned");
  let fullBootstrap = await expectStatus(await fullMember.get("/api/bootstrap"), 200, "specific-room bootstrap");
  let fullProjectB = workspaceProject(fullBootstrap, projectB);
  if (!fullProjectB || fullProjectB.rooms.length !== 1 || fullProjectB.rooms[0].id !== roomB1) {
    throw new Error("specific-room assignment exposed the wrong subprojects");
  }
  await expectStatus(
    await fullMember.post(`/api/rooms/${roomB1}/messages`).send({ kind: "update", text: "Blocked while read only." }),
    403,
    "specific-room read-only enforcement"
  );
  await assign(owner, fullId, projectB, "full", roomB1);
  await expectStatus(
    await fullMember.post(`/api/rooms/${roomB1}/messages`).send({ kind: "update", text: "Role updated." }),
    200,
    "specific-room full-access update"
  );
  const membershipCount = await pool.query(
    "SELECT COUNT(*) AS count FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomB1, fullId]
  );
  if (Number(membershipCount.rows[0].count) !== 1) throw new Error("role update duplicated room membership");

  await expectStatus(
    await owner.delete(`/api/admin/users/${fullId}/rooms/${roomB1}`),
    200,
    "specific-room removal"
  );
  fullBootstrap = await expectStatus(await fullMember.get("/api/bootstrap"), 200, "bootstrap after room removal");
  if (workspaceProject(fullBootstrap, projectB)) throw new Error("orphan container access remained after final room removal");

  await assign(owner, readonlyId, projectB, "readonly");
  let readonlyBootstrap = await expectStatus(await readonlyMember.get("/api/bootstrap"), 200, "project-wide assignment bootstrap");
  let readonlyProjectB = workspaceProject(readonlyBootstrap, projectB);
  if (!readonlyProjectB || readonlyProjectB.rooms.length !== 3 || readonlyProjectB.rooms.some((room) => room.role !== "readonly")) {
    throw new Error("project-wide read-only assignment did not cover current subprojects");
  }
  await assign(owner, readonlyId, projectB, "full");
  await expectStatus(
    await readonlyMember.post(`/api/rooms/${roomB2}/messages`).send({ kind: "update", text: "Promoted to full." }),
    200,
    "project-wide role promotion"
  );
  const roomB3 = (await createRoom(owner, projectB, "Room B3")).body.roomId;
  readonlyBootstrap = await expectStatus(await readonlyMember.get("/api/bootstrap"), 200, "future-room inheritance bootstrap");
  readonlyProjectB = workspaceProject(readonlyBootstrap, projectB);
  if (!readonlyProjectB.rooms.some((room) => room.id === roomB3 && room.role === "full")) {
    throw new Error("future subproject did not inherit project-wide membership");
  }

  await expectStatus(
    await owner.delete(`/api/admin/users/${readonlyId}/projects/${projectB}`),
    200,
    "project membership removal"
  );
  readonlyBootstrap = await expectStatus(await readonlyMember.get("/api/bootstrap"), 200, "bootstrap after project removal");
  if (workspaceProject(readonlyBootstrap, projectB)) throw new Error("project removal left visible room access");
  const survivingUser = await pool.query("SELECT id FROM users WHERE id = $1", [readonlyId]);
  if (!survivingUser.rows[0]) throw new Error("membership removal deleted the user account");

  await expectStatus(
    await owner.delete(`/api/admin/users/${ownerId}/projects/${projectA}`),
    400,
    "admin project-removal protection"
  );
  await expectStatus(
    await owner.delete(`/api/admin/users/${ownerId}/rooms/${roomA}`),
    400,
    "admin room-removal protection"
  );
  await expectStatus(
    await owner.post(`/api/admin/users/${ownerId}/assign`).send({ projectId: projectA, role: "readonly" }),
    400,
    "admin demotion protection"
  );

  await expectStatus(
    await owner.post(`/api/rooms/${roomA}/tasks`).send({
      title: "Cascade task",
      note: "Must disappear with Project A",
      assigneeId: ownerId
    }),
    200,
    "cascade task creation"
  );
  const usersBeforeProjectDelete = await pool.query("SELECT COUNT(*) AS count FROM users");
  await expectStatus(await owner.delete(`/api/projects/${projectA}`), 200, "project cascade deletion");
  const [deletedRoom, deletedMessages, deletedTasks, usersAfterProjectDelete] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM rooms WHERE id = $1", [roomA]),
    pool.query("SELECT COUNT(*) AS count FROM messages WHERE room_id = $1", [roomA]),
    pool.query("SELECT COUNT(*) AS count FROM tasks WHERE room_id = $1", [roomA]),
    pool.query("SELECT COUNT(*) AS count FROM users")
  ]);
  if ([deletedRoom, deletedMessages, deletedTasks].some((result) => Number(result.rows[0].count) !== 0)) {
    throw new Error("project deletion did not cascade through project data");
  }
  if (Number(usersAfterProjectDelete.rows[0].count) !== Number(usersBeforeProjectDelete.rows[0].count)) {
    throw new Error("project deletion removed user accounts");
  }

  const projectC = (await createProject(owner, "Project C")).body.projectId;
  const roomC = (await createRoom(owner, projectC, "Room C")).body.roomId;
  await assign(owner, fullId, projectC, "full");
  fullBootstrap = await expectStatus(await fullMember.get("/api/bootstrap"), 200, "reassignment after deletion");
  if (!workspaceProject(fullBootstrap, projectC)?.rooms.some((room) => room.id === roomC)) {
    throw new Error("existing account could not be reassigned after project deletion");
  }

  const finalDirectory = await expectStatus(await owner.get("/api/admin/users"), 200, "final member directory");
  if (finalDirectory.body.users.length !== 4) throw new Error("member directory lost an account during project operations");

  console.log("Smoke test passed: task deletion, member directory, direct assignment, roles, removals, and account preservation.");
}

run()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
