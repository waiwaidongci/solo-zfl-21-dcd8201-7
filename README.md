# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录、客户档案和送修登记。

## 启动

```bash
PORT=3021 node server.js
```

## 测试

```bash
npm test
```

## 主要接口

### 钟表 / 调校 / 复测（原有）

- `GET /health`
- `GET /clocks`
- `POST /clocks`（可带 `customerId` 直接绑定客户）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

### 客户档案

- `GET /customers?name=&phone=` — 客户列表（含名下钟表数）
- `POST /customers` — 客户建档，字段：`name`、`phone`、`note`；联系电话唯一，重复返回 409
- `GET /customers/:id` — 客户档案（含名下钟表与送修记录）
- `GET /customers/:id/clocks` — 客户名下钟表
- `PUT /clocks/:id/customer` — 绑定/改绑客户，body：`{"customerId":"..."}`；传 `null` 解绑

一只钟表绑定一名客户，一名客户可挂多只钟表。

### 送修登记

- `POST /repair-intakes` — 送修登记，字段：`clockId`、`expectedPickupDate`（预计取件日期），
  可选 `receivedAt`（送修时间，默认当前）、`status`、`note`；钟表须已绑定客户，否则返回 409
- `GET /repair-intakes?clockId=&customerId=&status=` — 登记列表
- `GET /repair-intakes/overdue?asOf=` — 逾期未取件列表（预计取件日期早于基准日且状态非「已取件」，
  `asOf` 默认为当前时间）
- `PATCH /repair-intakes/:id` — 更新 `status` / `expectedPickupDate` / `note` / `receivedAt`

状态取值：`在修` → `待取件` → `已取件`（置为「已取件」时自动记录 `pickedUpAt`）。

## 输入校验

- 必填字段传 `null`、空字符串或纯空白一律视为缺失，返回 400
- 客户姓名、联系电话必须是非空字符串（自动裁剪首尾空格），其他类型返回 400
- `expectedPickupDate`、`receivedAt` 必须可解析为合法日期（`receivedAt` 省略或传 `null` 时默认当前时间）
- 非法请求只返回 400 错误，不会写入任何客户、送修或修改记录

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```

## 送修示例

```bash
# 客户建档
curl -X POST http://127.0.0.1:3021/customers \
  -H 'Content-Type: application/json' \
  -d '{"name":"陈守时","phone":"13800001111","note":"老主顾"}'

# 钟表绑定客户
curl -X PUT http://127.0.0.1:3021/clocks/clock_demo/customer \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"customer_demo"}'

# 送修登记
curl -X POST http://127.0.0.1:3021/repair-intakes \
  -H 'Content-Type: application/json' \
  -d '{"clockId":"clock_demo","expectedPickupDate":"2026-10-01","note":"洗油保养"}'

# 逾期未取件
curl http://127.0.0.1:3021/repair-intakes/overdue
```
