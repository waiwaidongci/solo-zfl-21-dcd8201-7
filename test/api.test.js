const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { writeFile, rm } = require("fs/promises");
const os = require("os");
const path = require("path");

const TEST_DB = path.join(os.tmpdir(), `clock-api-test-${process.pid}.json`);
process.env.DB_FILE = TEST_DB;

const { createServer } = require("../server");

let server;
let base;

const emptyFixture = {
  clocks: [],
  adjustments: [],
  retests: [],
  customers: [],
  repairIntakes: []
};

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function seedCustomer(overrides = {}) {
  const res = await api("POST", "/customers", {
    name: "陈守时",
    phone: "13800001111",
    note: "老主顾",
    ...overrides
  });
  assert.equal(res.status, 201);
  return res.body.data;
}

async function seedClock(customerId, overrides = {}) {
  const res = await api("POST", "/clocks", {
    code: "CLK-0001",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 30,
    customerId,
    ...overrides
  });
  assert.equal(res.status, 201);
  return res.body.data;
}

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await writeFile(TEST_DB, JSON.stringify(emptyFixture, null, 2));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(TEST_DB, { force: true });
});

test("正常登记：客户建档、钟表绑定、送修登记与状态流转", async () => {
  // 客户档案登记
  const customer = await seedCustomer();
  assert.ok(customer.id.startsWith("customer_"));
  assert.equal(customer.name, "陈守时");
  assert.equal(customer.phone, "13800001111");

  // 缺少必填字段
  const missing = await api("POST", "/customers", { name: "缺电话" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /phone/);

  // 钟表建档并绑定客户
  const clock = await seedClock(customer.id);
  assert.equal(clock.customerId, customer.id);
  assert.equal(clock.customer.name, "陈守时");

  // 查询客户档案（含名下钟表与送修记录）
  const profile = await api("GET", `/customers/${customer.id}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.clocks.length, 1);
  assert.equal(profile.body.data.clocks[0].code, "CLK-0001");

  // 客户列表支持按电话查询
  const byPhone = await api("GET", "/customers?phone=13800001111");
  assert.equal(byPhone.body.data.length, 1);
  assert.equal(byPhone.body.data[0].clockCount, 1);

  // 客户名下钟表
  const clocks = await api("GET", `/customers/${customer.id}/clocks`);
  assert.equal(clocks.status, 200);
  assert.equal(clocks.body.data.length, 1);
  assert.equal(clocks.body.data[0].customer.name, "陈守时");

  // 送修登记：默认状态在修、送修时间自动填充
  const intake = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-01",
    note: "洗油保养"
  });
  assert.equal(intake.status, 201);
  assert.equal(intake.body.data.status, "在修");
  assert.ok(intake.body.data.receivedAt);
  assert.equal(intake.body.data.customerId, customer.id);
  assert.equal(intake.body.data.customer.phone, "13800001111");
  assert.equal(intake.body.data.pickedUpAt, null);

  // 预计取件日期不合法
  const badDate = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "不是日期"
  });
  assert.equal(badDate.status, 400);

  // 状态流转：在修 -> 待取件 -> 已取件
  const intakeId = intake.body.data.id;
  const ready = await api("PATCH", `/repair-intakes/${intakeId}`, { status: "待取件" });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.data.status, "待取件");

  const picked = await api("PATCH", `/repair-intakes/${intakeId}`, { status: "已取件" });
  assert.equal(picked.body.data.status, "已取件");
  assert.ok(picked.body.data.pickedUpAt);

  // 非法状态与不存在的登记单
  const badStatus = await api("PATCH", `/repair-intakes/${intakeId}`, { status: "已销毁" });
  assert.equal(badStatus.status, 400);
  const notFound = await api("PATCH", "/repair-intakes/intake_none", { status: "在修" });
  assert.equal(notFound.status, 404);

  // 按客户/状态过滤送修记录
  const list = await api("GET", `/repair-intakes?customerId=${customer.id}&status=已取件`);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, intakeId);
});

test("重复电话：同一联系电话不允许重复建档", async () => {
  await seedCustomer();

  const dup = await api("POST", "/customers", { name: "别人", phone: "13800001111" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /已登记/);

  // 首尾空格视为同一号码
  const dupTrim = await api("POST", "/customers", { name: "别人", phone: " 13800001111 " });
  assert.equal(dupTrim.status, 409);

  // 不同电话可以正常登记
  const ok = await api("POST", "/customers", { name: "李摆轮", phone: "13900002222" });
  assert.equal(ok.status, 201);

  const all = await api("GET", "/customers");
  assert.equal(all.body.data.length, 2);
});

test("未绑定钟表：未绑定客户不能登记送修，绑定后可登记", async () => {
  // 旧方式建档（不带客户），钟表处于未绑定状态
  const unbound = await api("POST", "/clocks", {
    code: "CLK-UNBOUND",
    escapementType: "工字轮",
    balanceFrequency: "21600vph"
  });
  assert.equal(unbound.status, 201);
  assert.equal(unbound.body.data.customerId, null);
  assert.equal(unbound.body.data.customer, null);
  const clockId = unbound.body.data.id;

  // 未绑定客户 -> 拒绝送修登记
  const rejected = await api("POST", "/repair-intakes", {
    clockId,
    expectedPickupDate: "2026-10-01"
  });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /未绑定客户/);

  // 绑定不存在的客户 -> 404
  const ghost = await api("PUT", `/clocks/${clockId}/customer`, { customerId: "customer_none" });
  assert.equal(ghost.status, 404);

  // 建档时指定不存在的客户 -> 404
  const badCreate = await api("POST", "/clocks", {
    code: "CLK-GHOST",
    escapementType: "工字轮",
    balanceFrequency: "21600vph",
    customerId: "customer_none"
  });
  assert.equal(badCreate.status, 404);

  // 绑定真实客户后可以登记送修
  const customer = await seedCustomer();
  const bound = await api("PUT", `/clocks/${clockId}/customer`, { customerId: customer.id });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.data.customer.id, customer.id);

  const accepted = await api("POST", "/repair-intakes", {
    clockId,
    expectedPickupDate: "2026-10-01"
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.data.customerId, customer.id);

  // 解绑后再次拒绝
  const unbind = await api("PUT", `/clocks/${clockId}/customer`, { customerId: null });
  assert.equal(unbind.body.data.customerId, null);
  const rejectedAgain = await api("POST", "/repair-intakes", {
    clockId,
    expectedPickupDate: "2026-11-01"
  });
  assert.equal(rejectedAgain.status, 409);
});

test("逾期未取件：只列出超过预计取件日期且未取件的登记单", async () => {
  const customer = await seedCustomer();
  const clockA = await seedClock(customer.id, { code: "CLK-A" });
  const clockB = await seedClock(customer.id, { code: "CLK-B" });
  const clockC = await seedClock(customer.id, { code: "CLK-C" });

  // 已逾期且在修
  const overdue = await api("POST", "/repair-intakes", {
    clockId: clockA.id,
    expectedPickupDate: "2020-01-01",
    note: "早就该取了"
  });
  assert.equal(overdue.status, 201);

  // 未到取件日期
  await api("POST", "/repair-intakes", { clockId: clockB.id, expectedPickupDate: "2999-01-01" });

  // 已逾期但已取件
  await api("POST", "/repair-intakes", {
    clockId: clockC.id,
    expectedPickupDate: "2020-06-01",
    status: "已取件"
  });

  const res = await api("GET", "/repair-intakes/overdue");
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  const row = res.body.data[0];
  assert.equal(row.clock.code, "CLK-A");
  assert.equal(row.customer.name, "陈守时");
  assert.equal(row.status, "在修");

  // asOf 可指定判定基准日：基准日早于预计取件日期则不算逾期
  const notYet = await api("GET", "/repair-intakes/overdue?asOf=2019-01-01");
  assert.equal(notYet.body.data.length, 0);

  // 已取件后从逾期列表消失
  await api("PATCH", `/repair-intakes/${overdue.body.data.id}`, { status: "已取件" });
  const cleared = await api("GET", "/repair-intakes/overdue");
  assert.equal(cleared.body.data.length, 0);
});

test("旧接口回归：钟表、调校、复测闭环行为不变", async () => {
  const health = await api("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  for (const route of ["GET /clocks", "POST /clocks/:id/adjustments", "POST /clocks/:id/retests", "GET /retests"]) {
    assert.ok(health.body.routes.includes(route), `routes 应包含 ${route}`);
  }

  // 旧方式建钟表（不带客户字段）
  const created = await api("POST", "/clocks", {
    code: "CLK-LEGACY",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20,
    note: "回归用"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.qualified, false);
  assert.equal(created.body.data.latestRetest, null);
  const clockId = created.body.data.id;

  // 缺字段仍是 400
  const missing = await api("POST", "/clocks", { code: "CLK-X" });
  assert.equal(missing.status, 400);

  // 调校记录
  const adjustment = await api("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 55,
    direction: "慢针方向",
    amount: "快慢针向慢侧0.3格"
  });
  assert.equal(adjustment.status, 201);
  assert.equal(adjustment.body.data.clockId, clockId);

  // 复测：未显式传 qualified 时按目标日差自动判定
  const retest = await api("POST", `/clocks/${clockId}/retests`, {
    dailyRateSeconds: 12,
    amplitude: 250
  });
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.qualified, true);
  assert.equal(retest.body.data.adjustmentId, adjustment.body.data.id);
  assert.equal(retest.body.clock.qualified, true);

  // 最新复测与历史
  const latest = await api("GET", `/clocks/${clockId}/latest-retest`);
  assert.equal(latest.body.data.qualified, true);
  const history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.adjustments.length, 1);
  assert.equal(history.body.data.retests.length, 1);

  // 合格/不合格列表
  const qualifiedList = await api("GET", "/clocks?qualified=true");
  assert.ok(qualifiedList.body.data.some((item) => item.id === clockId));
  const notQualified = await api("GET", "/clocks/not-qualified");
  assert.ok(!notQualified.body.data.some((item) => item.id === clockId));

  // 调校/复测列表过滤
  const adjustments = await api("GET", `/adjustments?clockId=${clockId}`);
  assert.equal(adjustments.body.data.length, 1);
  const retests = await api("GET", `/retests?clockId=${clockId}&qualified=true`);
  assert.equal(retests.body.data.length, 1);

  // 不存在的钟表与未知路由
  const ghost = await api("GET", "/clocks/clock_none/history");
  assert.equal(ghost.status, 404);
  const unknown = await api("GET", "/no-such-route");
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /接口不存在/);
});
