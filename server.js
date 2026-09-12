const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const REPAIR_STATUSES = ["在修", "待取件", "已取件"];
const DAY_SECONDS = 86400;

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      customerId: "customer_demo",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  customers: [
    {
      id: "customer_demo",
      name: "陈守时",
      phone: "13800001111",
      note: "老主顾，取件前电话确认",
      createdAt: new Date().toISOString()
    }
  ],
  repairIntakes: [
    {
      id: "intake_demo",
      clockId: "clock_demo",
      customerId: "customer_demo",
      receivedAt: new Date().toISOString(),
      status: "在修",
      expectedPickupDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      note: "洗油保养并调校走时",
      pickedUpAt: null
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "PUT /clocks/:id/customer",
  "GET /adjustments",
  "GET /retests",
  "GET /customers",
  "POST /customers",
  "GET /customers/:id",
  "GET /customers/:id/clocks",
  "GET /repair-intakes",
  "POST /repair-intakes",
  "GET /repair-intakes/overdue",
  "PATCH /repair-intakes/:id"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function normalizeDb(db) {
  return {
    clocks: Array.isArray(db.clocks) ? db.clocks : [],
    adjustments: Array.isArray(db.adjustments) ? db.adjustments : [],
    retests: Array.isArray(db.retests) ? db.retests : [],
    customers: Array.isArray(db.customers) ? db.customers : [],
    repairIntakes: Array.isArray(db.repairIntakes) ? db.repairIntakes : []
  };
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function findCustomer(db, customerId) {
  const customer = db.customers.find((item) => item.id === customerId);
  if (!customer) {
    const error = new Error("客户不存在");
    error.status = 404;
    throw error;
  }
  return customer;
}

function findIntake(db, intakeId) {
  const intake = db.repairIntakes.find((item) => item.id === intakeId);
  if (!intake) {
    const error = new Error("送修登记不存在");
    error.status = 404;
    throw error;
  }
  return intake;
}

function parseDate(value, message) {
  const isDateLike = typeof value === "string" || typeof value === "number";
  const date = isDateLike ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
  return date;
}

function validStatus(status) {
  if (!REPAIR_STATUSES.includes(status)) {
    const error = new Error(`状态不合法，可选：${REPAIR_STATUSES.join(" / ")}`);
    error.status = 400;
    throw error;
  }
  return status;
}

function validNumber(value, field, min, max, exclusiveMin = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    const error = new Error(`${field}必须是数字`);
    error.status = 400;
    throw error;
  }
  const tooLow = exclusiveMin ? value <= min : value < min;
  if (tooLow || value > max) {
    const error = new Error(`${field}超出允许范围：${exclusiveMin ? "(" : "["}${min}, ${max}]`);
    error.status = 400;
    throw error;
  }
  return value;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const customer = db.customers.find((item) => item.id === clock.customerId) || null;
  return {
    ...clock,
    customerId: clock.customerId || null,
    customer,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

function intakeSummary(db, intake) {
  const clock = db.clocks.find((item) => item.id === intake.clockId) || null;
  const customer = db.customers.find((item) => item.id === intake.customerId) || null;
  return { ...intake, clock, customer };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    if (body.customerId !== undefined && body.customerId !== null) {
      findCustomer(db, body.customerId);
    }
    if (body.targetDailyRateSeconds !== undefined && body.targetDailyRateSeconds !== null) {
      validNumber(body.targetDailyRateSeconds, "targetDailyRateSeconds", 0, DAY_SECONDS, true);
    }
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: body.targetDailyRateSeconds ?? 30,
      note: body.note || "",
      customerId: body.customerId || null,
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    validNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds", -DAY_SECONDS, DAY_SECONDS);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: body.currentDailyRateSeconds,
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    validNumber(body.dailyRateSeconds, "dailyRateSeconds", -DAY_SECONDS, DAY_SECONDS);
    validNumber(body.amplitude, "amplitude", 0, 360, true);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(body.dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: body.dailyRateSeconds,
      amplitude: body.amplitude,
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  const bindMatch = pathname.match(/^\/clocks\/([^/]+)\/customer$/);
  if (bindMatch && req.method === "PUT") {
    const clock = findClock(db, bindMatch[1]);
    const body = await parseBody(req);
    if (body.customerId === undefined) {
      const error = new Error("缺少字段：customerId");
      error.status = 400;
      throw error;
    }
    if (body.customerId !== null) {
      findCustomer(db, body.customerId);
    }
    clock.customerId = body.customerId;
    await writeDb(db);
    return send(res, 200, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/customers") {
    const name = url.searchParams.get("name");
    const phone = url.searchParams.get("phone");
    const data = db.customers
      .filter((item) => {
        const matchName = !name || item.name.includes(name);
        const matchPhone = !phone || item.phone === phone;
        return matchName && matchPhone;
      })
      .map((item) => ({
        ...item,
        clockCount: db.clocks.filter((clock) => clock.customerId === item.id).length
      }));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/customers") {
    const body = await parseBody(req);
    required(body, ["name", "phone"]);
    const name = requiredString(body.name, "客户姓名必须是非空字符串");
    const phone = requiredString(body.phone, "联系电话必须是非空字符串");
    const duplicated = db.customers.find((item) => item.phone === phone);
    if (duplicated) {
      const error = new Error(`联系电话已登记：${phone}（客户：${duplicated.name}）`);
      error.status = 409;
      throw error;
    }
    const customer = {
      id: makeId("customer"),
      name,
      phone,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.customers.push(customer);
    await writeDb(db);
    return send(res, 201, { data: customer });
  }

  const customerMatch = pathname.match(/^\/customers\/([^/]+)$/);
  if (customerMatch && req.method === "GET") {
    const customer = findCustomer(db, customerMatch[1]);
    const clocks = db.clocks
      .filter((item) => item.customerId === customer.id)
      .map((clock) => clockSummary(db, clock));
    const repairIntakes = db.repairIntakes
      .filter((item) => item.customerId === customer.id)
      .map((intake) => intakeSummary(db, intake));
    return send(res, 200, { data: { ...customer, clocks, repairIntakes } });
  }

  const customerClocksMatch = pathname.match(/^\/customers\/([^/]+)\/clocks$/);
  if (customerClocksMatch && req.method === "GET") {
    const customer = findCustomer(db, customerClocksMatch[1]);
    const data = db.clocks
      .filter((item) => item.customerId === customer.id)
      .map((clock) => clockSummary(db, clock));
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/repair-intakes") {
    const clockId = url.searchParams.get("clockId");
    const customerId = url.searchParams.get("customerId");
    const status = url.searchParams.get("status");
    const data = db.repairIntakes
      .filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchCustomer = !customerId || item.customerId === customerId;
        const matchStatus = !status || item.status === status;
        return matchClock && matchCustomer && matchStatus;
      })
      .map((intake) => intakeSummary(db, intake));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/repair-intakes") {
    const body = await parseBody(req);
    required(body, ["clockId", "expectedPickupDate"]);
    const clock = findClock(db, body.clockId);
    if (!clock.customerId) {
      const error = new Error("钟表未绑定客户，请先绑定客户再登记送修");
      error.status = 409;
      throw error;
    }
    const customer = findCustomer(db, clock.customerId);
    parseDate(body.expectedPickupDate, "预计取件日期不合法");
    if (body.receivedAt !== undefined && body.receivedAt !== null) {
      parseDate(body.receivedAt, "送修时间不合法");
    }
    const status = body.status === undefined ? "在修" : validStatus(body.status);
    const intake = {
      id: makeId("intake"),
      clockId: clock.id,
      customerId: customer.id,
      receivedAt: body.receivedAt ?? new Date().toISOString(),
      status,
      expectedPickupDate: body.expectedPickupDate,
      note: body.note || "",
      pickedUpAt: status === "已取件" ? new Date().toISOString() : null
    };
    db.repairIntakes.push(intake);
    await writeDb(db);
    return send(res, 201, { data: intakeSummary(db, intake) });
  }

  if (req.method === "GET" && pathname === "/repair-intakes/overdue") {
    const asOfParam = url.searchParams.get("asOf");
    const asOf = asOfParam ? parseDate(asOfParam, "asOf日期不合法") : new Date();
    const data = db.repairIntakes
      .filter((item) => item.status !== "已取件" && new Date(item.expectedPickupDate) < asOf)
      .sort((a, b) => new Date(a.expectedPickupDate) - new Date(b.expectedPickupDate))
      .map((intake) => intakeSummary(db, intake));
    return send(res, 200, { asOf: asOf.toISOString(), data });
  }

  const intakeMatch = pathname.match(/^\/repair-intakes\/([^/]+)$/);
  if (intakeMatch && req.method === "PATCH") {
    const intake = findIntake(db, intakeMatch[1]);
    const body = await parseBody(req);
    if (body.status !== undefined) {
      intake.status = validStatus(body.status);
      intake.pickedUpAt = intake.status === "已取件"
        ? intake.pickedUpAt || new Date().toISOString()
        : null;
    }
    if (body.expectedPickupDate !== undefined) {
      parseDate(body.expectedPickupDate, "预计取件日期不合法");
      intake.expectedPickupDate = body.expectedPickupDate;
    }
    if (body.note !== undefined) {
      intake.note = body.note;
    }
    if (body.receivedAt !== undefined) {
      parseDate(body.receivedAt, "送修时间不合法");
      intake.receivedAt = body.receivedAt;
    }
    await writeDb(db);
    return send(res, 200, { data: intakeSummary(db, intake) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer, REPAIR_STATUSES };
