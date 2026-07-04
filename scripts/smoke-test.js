process.env.USE_PGMEM = "1";
process.env.NODE_ENV = "test";
process.env.APP_URL = "http://projectchat.test";

const request = require("supertest");
const migrate = require("./migrate");
const { pool } = require("../db");

async function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label}: expected ${status}, received ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response;
}

async function run() {
  await migrate();
  const app = require("../server");
  const owner = request.agent(app);
  const teammate = request.agent(app);

  const emptyUsers = await pool.query("SELECT COUNT(*) AS count FROM users");
  if (Number(emptyUsers.rows[0].count) !== 0) throw new Error("fresh migration contained seeded users");
  const home = await owner.get("/");
  await expectStatus(home, 200, "frontend delivery");
  if (!home.text.includes("ProjectChat")) throw new Error("frontend HTML was not delivered");
  await expectStatus(await owner.get("/api/health"), 200, "database health check");

  const ownerRegistration = await owner.post("/api/auth/register").send({
    name: "Owner",
    email: "owner@example.com",
    password: "strong-password"
  });
  await expectStatus(ownerRegistration, 200, "owner registration");
  if (!ownerRegistration.body.user.is_admin || ownerRegistration.body.user.approval_status !== "approved") {
    throw new Error("the first account was not promoted to approved administrator");
  }
  const ownerId = ownerRegistration.body.user.id;

  const projectResponse = await owner.post("/api/projects").send({
    name: "Production Launch",
    description: "Coordinate launch work"
  });
  await expectStatus(projectResponse, 200, "project creation");

  const roomResponse = await owner
    .post(`/api/projects/${projectResponse.body.projectId}/rooms`)
    .send({ name: "Website", description: "Ship the website" });
  await expectStatus(roomResponse, 200, "subproject creation");
  const roomId = roomResponse.body.roomId;

  await expectStatus(
    await owner.post(`/api/rooms/${roomId}/messages`).send({ kind: "update", text: "Homepage is ready." }),
    200,
    "message creation"
  );
  await expectStatus(
    await owner.post(`/api/rooms/${roomId}/tasks`).send({
      title: "Review homepage",
      note: "Check mobile layout",
      assigneeId: ownerId
    }),
    200,
    "task creation"
  );

  const teammateRegistration = await teammate.post("/api/auth/register").send({
    name: "Viewer",
    email: "viewer@example.com",
    password: "strong-password"
  });
  await expectStatus(teammateRegistration, 200, "teammate registration");
  if (teammateRegistration.body.user.approval_status !== "pending") {
    throw new Error("a non-admin open signup was not placed into pending approval");
  }
  await expectStatus(await teammate.get("/api/bootstrap"), 403, "pending-account restriction");

  const inviteResponse = await owner.post("/api/invites").send({
    projectId: projectResponse.body.projectId,
    roomId: "",
    email: "viewer@example.com",
    role: "readonly"
  });
  await expectStatus(inviteResponse, 200, "invite creation");
  if (!inviteResponse.body.inviteUrl.includes("?invite=")) throw new Error("invite URL was not returned");

  await expectStatus(
    await teammate.post(`/api/invites/${inviteResponse.body.invite.token}/accept`),
    200,
    "invite acceptance"
  );
  const teammateBootstrap = await teammate.get("/api/bootstrap");
  await expectStatus(teammateBootstrap, 200, "teammate bootstrap");
  if (teammateBootstrap.body.workspace[0].rooms[0].role !== "readonly") {
    throw new Error("project-wide read-only permission was not copied to the subproject");
  }
  await expectStatus(
    await teammate.post(`/api/rooms/${roomId}/messages`).send({ kind: "update", text: "Should be blocked" }),
    403,
    "read-only enforcement"
  );

  const details = await owner.get(`/api/rooms/${roomId}`);
  await expectStatus(details, 200, "room details");
  if (details.body.messages.length < 3 || details.body.tasks.length !== 1) {
    throw new Error("room messages or tasks were not persisted correctly");
  }

  await expectStatus(
    await teammate.post("/api/projects").send({ name: "Unauthorized project" }),
    403,
    "non-admin project restriction"
  );
  await expectStatus(
    await teammate.delete(`/api/rooms/${roomId}`),
    403,
    "non-admin deletion restriction"
  );

  const applicant = request.agent(app);
  const applicantRegistration = await applicant.post("/api/auth/register").send({
    name: "Applicant",
    email: "applicant@example.com",
    password: "strong-password"
  });
  await expectStatus(applicantRegistration, 200, "applicant registration");
  const adminOverview = await owner.get("/api/admin/overview");
  await expectStatus(adminOverview, 200, "admin overview");
  if (!adminOverview.body.pendingUsers.some((user) => user.id === applicantRegistration.body.user.id)) {
    throw new Error("pending applicant did not appear in the admin overview");
  }
  await expectStatus(
    await owner.post(`/api/admin/users/${applicantRegistration.body.user.id}/approve`).send({
      projectId: projectResponse.body.projectId,
      role: "full"
    }),
    200,
    "admin approval"
  );
  const applicantBootstrap = await applicant.get("/api/bootstrap");
  await expectStatus(applicantBootstrap, 200, "approved applicant bootstrap");
  if (applicantBootstrap.body.workspace[0].rooms[0].role !== "full") {
    throw new Error("approved applicant was not assigned to the selected project");
  }

  const disposableRoom = await owner
    .post(`/api/projects/${projectResponse.body.projectId}/rooms`)
    .send({ name: "Disposable", description: "Deletion test" });
  await expectStatus(disposableRoom, 200, "disposable chat creation");
  await expectStatus(
    await owner.delete(`/api/rooms/${disposableRoom.body.roomId}`),
    200,
    "admin chat deletion"
  );
  await expectStatus(
    await owner.delete(`/api/projects/${projectResponse.body.projectId}`),
    200,
    "admin project deletion"
  );
  const remaining = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM projects"),
    pool.query("SELECT COUNT(*) AS count FROM rooms"),
    pool.query("SELECT COUNT(*) AS count FROM messages"),
    pool.query("SELECT COUNT(*) AS count FROM tasks")
  ]);
  if (remaining.some((result) => Number(result.rows[0].count) !== 0)) {
    throw new Error("project deletion did not cascade through chats, messages, and tasks");
  }

  console.log("Smoke test passed: admin approval, assignments, permissions, persistence, and cascade deletion.");
}

run()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
