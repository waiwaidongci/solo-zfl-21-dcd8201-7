const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { writeFile, rm } = require("fs/promises");
const os = require("os");
const path = require("path");

const TEST_DB = path.join(os.tmpdir(), `clock-api-validation-test-${process.pid}.json`);
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

async function seedCustomer() {
  const res = await api("POST", "/customers", { name: "陈守时", phone: "13800001111" });
  assert.equal(res.status, 201);
  return res.body.data;
}

async function seedBoundClock(customerId) {
  const res = await api("POST", "/clocks", {
    code: "CLK-0001",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    customerId
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

test("客户建档：null、空值、非字符串被拒绝且不写入", async () => {
  const badBodies = [
    { name: null, phone: "13811112222" },
    { name: "张三", phone: null },
    { name: null, phone: null },
    { name: "   ", phone: "13811112222" },
    { name: "张三", phone: "" },
    { name: "张三", phone: "   " },
    { name: 123, phone: "13811112222" },
    { name: "张三", phone: { num: 1 } },
    { name: ["张三"], phone: "13811112222" }
  ];
  for (const body of badBodies) {
    const res = await api("POST", "/customers", body);
    assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
    assert.ok(res.body.error, "应返回明确错误信息");
  }

  // 一个都没写进去
  const list = await api("GET", "/customers");
  assert.equal(list.body.data.length, 0);

  // 正常路径：首尾空格裁剪后建档
  const ok = await api("POST", "/customers", { name: " 张三 ", phone: " 13811112222 ", note: "新客" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.name, "张三");
  assert.equal(ok.body.data.phone, "13811112222");
});

test("送修登记：null 与非法日期被拒绝且不写入", async () => {
  const customer = await seedCustomer();
  const clock = await seedBoundClock(customer.id);

  const badBodies = [
    { clockId: clock.id, expectedPickupDate: null },
    { clockId: clock.id, expectedPickupDate: "" },
    { clockId: clock.id, expectedPickupDate: "下周三吧" },
    { clockId: clock.id, expectedPickupDate: "2026-13-45" },
    { clockId: clock.id, expectedPickupDate: true },
    { clockId: null, expectedPickupDate: "2026-10-01" },
    { clockId: clock.id, expectedPickupDate: "2026-10-01", receivedAt: "前天上午" },
    { clockId: clock.id, expectedPickupDate: "2026-10-01", receivedAt: "" },
    { clockId: clock.id, expectedPickupDate: "2026-10-01", receivedAt: {} }
  ];
  for (const body of badBodies) {
    const res = await api("POST", "/repair-intakes", body);
    assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
    assert.ok(res.body.error, "应返回明确错误信息");
  }

  // 一条都没写进去
  const list = await api("GET", "/repair-intakes");
  assert.equal(list.body.data.length, 0);

  // 正常路径1：省略送修时间，默认当前时间
  const defaulted = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-01"
  });
  assert.equal(defaulted.status, 201);
  assert.ok(defaulted.body.data.receivedAt);

  // 正常路径2：显式合法送修时间，原样保留
  const explicit = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-02",
    receivedAt: "2026-09-01T08:00:00.000Z"
  });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.data.receivedAt, "2026-09-01T08:00:00.000Z");

  // 正常路径3：receivedAt 显式传 null 视为未提供，用默认时间
  const nullReceived = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-03",
    receivedAt: null
  });
  assert.equal(nullReceived.status, 201);
  assert.ok(nullReceived.body.data.receivedAt);

  const all = await api("GET", "/repair-intakes");
  assert.equal(all.body.data.length, 3);
});

test("送修修改：非法修改被拒绝且原记录不变", async () => {
  const customer = await seedCustomer();
  const clock = await seedBoundClock(customer.id);
  const created = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-01",
    receivedAt: "2026-09-01T08:00:00.000Z",
    note: "原件"
  });
  assert.equal(created.status, 201);
  const intakeId = created.body.data.id;

  const badBodies = [
    { expectedPickupDate: null },
    { expectedPickupDate: "改天再说" },
    { receivedAt: null },
    { receivedAt: "不好说" },
    { status: null },
    { status: "已销毁" }
  ];
  for (const body of badBodies) {
    const res = await api("PATCH", `/repair-intakes/${intakeId}`, body);
    assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
  }

  // 原记录未被修改
  const list = await api("GET", "/repair-intakes");
  const saved = list.body.data.find((item) => item.id === intakeId);
  assert.equal(saved.expectedPickupDate, "2026-10-01");
  assert.equal(saved.receivedAt, "2026-09-01T08:00:00.000Z");
  assert.equal(saved.status, "在修");
  assert.equal(saved.note, "原件");

  // 正常修改仍可用
  const ok = await api("PATCH", `/repair-intakes/${intakeId}`, {
    expectedPickupDate: "2026-11-01",
    receivedAt: "2026-09-02T08:00:00.000Z",
    status: "待取件"
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.expectedPickupDate, "2026-11-01");
  assert.equal(ok.body.data.receivedAt, "2026-09-02T08:00:00.000Z");
  assert.equal(ok.body.data.status, "待取件");
});

test("送修状态：null、空字符串、非法状态被拒绝，省略默认在修", async () => {
  const customer = await seedCustomer();
  const clock = await seedBoundClock(customer.id);

  // 创建：null、空字符串、非法状态 -> 400 且不写入
  const badStatuses = [null, "", "   ", "已销毁", "done", 1];
  for (const status of badStatuses) {
    const res = await api("POST", "/repair-intakes", {
      clockId: clock.id,
      expectedPickupDate: "2026-10-01",
      status
    });
    assert.equal(res.status, 400, `创建应拒绝 status=${JSON.stringify(status)}`);
    assert.match(res.body.error, /状态不合法/);
  }
  let list = await api("GET", "/repair-intakes");
  assert.equal(list.body.data.length, 0);

  // 省略状态 -> 默认在修
  const defaulted = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-01"
  });
  assert.equal(defaulted.status, 201);
  assert.equal(defaulted.body.data.status, "在修");

  // 显式合法状态 -> 按给定状态创建
  const ready = await api("POST", "/repair-intakes", {
    clockId: clock.id,
    expectedPickupDate: "2026-10-02",
    status: "待取件"
  });
  assert.equal(ready.status, 201);
  assert.equal(ready.body.data.status, "待取件");

  // 修改：null、空字符串、非法状态 -> 400 且原记录不变
  const intakeId = defaulted.body.data.id;
  for (const status of badStatuses) {
    const res = await api("PATCH", `/repair-intakes/${intakeId}`, { status });
    assert.equal(res.status, 400, `修改应拒绝 status=${JSON.stringify(status)}`);
    assert.match(res.body.error, /状态不合法/);
  }
  list = await api("GET", "/repair-intakes");
  const saved = list.body.data.find((item) => item.id === intakeId);
  assert.equal(saved.status, "在修");

  // 合法流转：在修 -> 待取件 -> 已取件
  const toReady = await api("PATCH", `/repair-intakes/${intakeId}`, { status: "待取件" });
  assert.equal(toReady.status, 200);
  assert.equal(toReady.body.data.status, "待取件");
  const toPicked = await api("PATCH", `/repair-intakes/${intakeId}`, { status: "已取件" });
  assert.equal(toPicked.status, 200);
  assert.equal(toPicked.body.data.status, "已取件");
  assert.ok(toPicked.body.data.pickedUpAt);
});

test("数值字段：错误类型、不可解析内容与超范围被拒绝，合法值与边界值正常", async () => {
  // 建钟 targetDailyRateSeconds：字符串、对象、数组、布尔、超范围 -> 400
  const badTargets = ["20", "abc", {}, [], true, 0, -5, 86401];
  for (const targetDailyRateSeconds of badTargets) {
    const res = await api("POST", "/clocks", {
      code: "CLK-NUM",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds
    });
    assert.equal(res.status, 400, `应拒绝 targetDailyRateSeconds=${JSON.stringify(targetDailyRateSeconds)}`);
    assert.match(res.body.error, /targetDailyRateSeconds/);
  }
  let clocks = await api("GET", "/clocks");
  assert.equal(clocks.body.data.length, 0);

  // 合法：省略默认 30、null 视为省略、边界 1 与 86400
  const def = await api("POST", "/clocks", {
    code: "CLK-D",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph"
  });
  assert.equal(def.status, 201);
  assert.equal(def.body.data.targetDailyRateSeconds, 30);
  const nullTarget = await api("POST", "/clocks", {
    code: "CLK-NULL",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: null
  });
  assert.equal(nullTarget.status, 201);
  assert.equal(nullTarget.body.data.targetDailyRateSeconds, 30);
  for (const value of [1, 20, 86400]) {
    const res = await api("POST", "/clocks", {
      code: `CLK-${value}`,
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: value
    });
    assert.equal(res.status, 201, `应接受 targetDailyRateSeconds=${value}`);
    assert.equal(res.body.data.targetDailyRateSeconds, value);
  }
  clocks = await api("GET", "/clocks");
  assert.equal(clocks.body.data.length, 5);

  // 调校 currentDailyRateSeconds：错误类型与超范围 -> 400
  const clockId = def.body.data.id;
  const badRates = ["55", "abc", {}, [], true, 86401, -86401];
  for (const currentDailyRateSeconds of badRates) {
    const res = await api("POST", `/clocks/${clockId}/adjustments`, {
      currentDailyRateSeconds,
      direction: "慢针方向",
      amount: "快慢针向慢侧0.3格"
    });
    assert.equal(res.status, 400, `应拒绝 currentDailyRateSeconds=${JSON.stringify(currentDailyRateSeconds)}`);
    assert.match(res.body.error, /currentDailyRateSeconds/);
  }
  let history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.adjustments.length, 0);

  // 合法：0、负值、边界 ±86400
  for (const value of [0, -12, 86400, -86400]) {
    const res = await api("POST", `/clocks/${clockId}/adjustments`, {
      currentDailyRateSeconds: value,
      direction: "慢针方向",
      amount: "快慢针向慢侧0.3格"
    });
    assert.equal(res.status, 201, `应接受 currentDailyRateSeconds=${value}`);
    assert.equal(res.body.data.currentDailyRateSeconds, value);
  }
  history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.adjustments.length, 4);

  // 复测 dailyRateSeconds / amplitude：错误类型与超范围 -> 400
  const badRetests = [
    { dailyRateSeconds: "12", amplitude: 250 },
    { dailyRateSeconds: {}, amplitude: 250 },
    { dailyRateSeconds: 86401, amplitude: 250 },
    { dailyRateSeconds: -86401, amplitude: 250 },
    { dailyRateSeconds: 12, amplitude: "250" },
    { dailyRateSeconds: 12, amplitude: "abc" },
    { dailyRateSeconds: 12, amplitude: [] },
    { dailyRateSeconds: 12, amplitude: 0 },
    { dailyRateSeconds: 12, amplitude: -10 },
    { dailyRateSeconds: 12, amplitude: 361 }
  ];
  for (const body of badRetests) {
    const res = await api("POST", `/clocks/${clockId}/retests`, body);
    assert.equal(res.status, 400, `应拒绝 ${JSON.stringify(body)}`);
    assert.match(res.body.error, /dailyRateSeconds|amplitude/);
  }
  history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.retests.length, 0);

  // 合法：日差 0 与边界 ±86400、振幅边界 1 与 360
  const goodRetests = [
    { dailyRateSeconds: 0, amplitude: 250 },
    { dailyRateSeconds: 86400, amplitude: 1 },
    { dailyRateSeconds: -86400, amplitude: 360 }
  ];
  for (const body of goodRetests) {
    const res = await api("POST", `/clocks/${clockId}/retests`, body);
    assert.equal(res.status, 201, `应接受 ${JSON.stringify(body)}`);
  }
  history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.retests.length, 3);
});

test("旧接口必填字段传 null 同样被拒绝，正常流程不受影响", async () => {
  // 建钟：必填字段为 null
  const nullCode = await api("POST", "/clocks", {
    code: null,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph"
  });
  assert.equal(nullCode.status, 400);

  // 正常建钟
  const created = await api("POST", "/clocks", {
    code: "CLK-LEGACY",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20
  });
  assert.equal(created.status, 201);
  const clockId = created.body.data.id;

  // 调校：必填字段为 null
  const nullAdjustment = await api("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: null,
    direction: "慢针方向",
    amount: "快慢针向慢侧0.3格"
  });
  assert.equal(nullAdjustment.status, 400);

  // 正常调校
  const adjustment = await api("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 55,
    direction: "慢针方向",
    amount: "快慢针向慢侧0.3格"
  });
  assert.equal(adjustment.status, 201);

  // 复测：必填字段为 null
  const nullRetest = await api("POST", `/clocks/${clockId}/retests`, {
    dailyRateSeconds: null,
    amplitude: 250
  });
  assert.equal(nullRetest.status, 400);

  // 正常复测
  const retest = await api("POST", `/clocks/${clockId}/retests`, {
    dailyRateSeconds: 12,
    amplitude: 250
  });
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.qualified, true);

  // 非法请求都没有落盘：一钟、一调校、一复测
  const history = await api("GET", `/clocks/${clockId}/history`);
  assert.equal(history.body.data.adjustments.length, 1);
  assert.equal(history.body.data.retests.length, 1);
  const clocks = await api("GET", "/clocks");
  assert.equal(clocks.body.data.length, 1);
});
