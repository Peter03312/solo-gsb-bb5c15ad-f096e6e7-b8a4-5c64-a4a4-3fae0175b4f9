/* eslint-disable no-console */
// 端到端验证：航次安全约束变更（整组替换 + 乐观修订号 + 当前布局复验 + 历史留痕）
// 运行: node test/e2e-constraints.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30197;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-constraints'),
    user: 'stowage',
    password: 'stowage',
    port: 54397,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54397/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 1. 登记航次 ----
    //  3 bay x 2 row x 2 tier；列 (1,1) 覆盖 1200；不相容 (1,3) 距离 3
    const createBody = {
      voyageNo: 'V-CON-001',
      bays: 3,
      rows: 2,
      tiers: 2,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      boxes: [
        { boxNo: 'BOX-1', weight: '500', category: '1' },
        { boxNo: 'BOX-2', weight: '600', category: '3' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    };
    const { body: voyage } = await http('POST', `${BASE}/voyages`, createBody, 201);
    const vid = voyage.id;
    check('登记返回 revision=0', voyage.revision === 0);

    // ---- 2. 当前布局带出 rev=0 生效约束 ----
    let layout = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check(
      '布局内嵌约束为登记清单',
      layout.defaultColumnWeightLimit === '10000' &&
        layout.columnWeightLimits.length === 1 &&
        layout.incompatRules.length === 1 &&
        layout.incompatRules[0].minDistance === 3,
      JSON.stringify({ d: layout.defaultColumnWeightLimit, c: layout.columnWeightLimits, r: layout.incompatRules }),
    );

    // 专用约束查询
    const c0 = (await http('GET', `${BASE}/voyages/${vid}/constraints`, undefined, 200)).body;
    check(
      'GET constraints 当前修订号',
      c0.revision === 0 && c0.current === true && c0.columnWeightLimits[0].bay === 1,
    );

    // ---- 3. 先放一个在旧约束下合法的布局 -> rev1 ----
    // BOX-1(cat1)@(1,1,0)，BOX-2(cat3)@(3,2,0)，距离 |2|+1=3 达标
    const r1 = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 3, row: 2, tier: 0 } },
      ],
    }, 200);
    check('合法布局 revision=1', r1.body.revision === 1);

    // ---- 4. 约束变更：当前布局在新约束下违规（距离要求提到 4）-> 422，规则/修订号不变 ----
    const stricter = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 4 }],
    });
    check('复验不通过 422 validation_failed', stricter.status === 422);
    const vv = stricter.body.error.details.violations[0];
    check(
      '违反含箱号/位置/原因',
      vv.reason === 'incompatible_too_close' &&
        vv.boxA === 'BOX-1' &&
        vv.boxB === 'BOX-2' &&
        vv.distance === 3 &&
        vv.minDistance === 4 &&
        vv.positionA.bay === 1 &&
        vv.positionB.bay === 3,
      JSON.stringify(vv),
    );
    layout = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check(
      '拒绝后修订号与约束均不变',
      layout.revision === 1 && layout.incompatRules[0].minDistance === 3,
    );

    // ---- 5. 新约束令列超重（默认上限降到 400）-> 422 column_overweight ----
    const heavier = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '400',
      columnWeightLimits: [],
      incompatRules: [],
    });
    check(
      '列超重复验 422 column_overweight',
      heavier.status === 422 &&
        heavier.body.error.details.violations.some(
          (x) => x.reason === 'column_overweight' && x.boxNos.includes('BOX-1'),
        ),
    );

    // ---- 6. 过期修订号 -> 409，回带当前修订号 ----
    const stale = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 99,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [],
      incompatRules: [],
    });
    check(
      '过期修订号 409 stale_revision 回带当前号',
      stale.status === 409 &&
        stale.body.error.code === 'stale_revision' &&
        stale.body.error.details.currentRevision === 1,
    );

    // ---- 7. 请求级校验：非正重量 / 坐标越界 / 列覆盖重复 / 类别对重复 -> 400 ----
    const badWeight = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '0',
      columnWeightLimits: [],
      incompatRules: [],
    });
    check('默认承重非正 400', badWeight.status === 400);

    const badCoord = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 9, row: 1, weightLimit: '1200' }],
      incompatRules: [],
    });
    check(
      '列坐标越界 400 invalid_column_limit',
      badCoord.status === 400 &&
        badCoord.body.error.details.issues.some((i) => i.reason === 'invalid_column_limit'),
    );

    const dupCol = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [
        { bay: 1, row: 1, weightLimit: '1200' },
        { bay: 1, row: 1, weightLimit: '1300' },
      ],
      incompatRules: [],
    });
    check(
      '列覆盖重复 400 duplicate_column_limit',
      dupCol.status === 400 &&
        dupCol.body.error.details.issues.some((i) => i.reason === 'duplicate_column_limit'),
    );

    const dupRule = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [],
      incompatRules: [
        { categoryA: '3', categoryB: '1', minDistance: 2 },
        { categoryA: '1', categoryB: '3', minDistance: 2 },
      ],
    });
    check(
      '类别对重复（归一化后）400 duplicate_incompat_rule',
      dupRule.status === 400 &&
        dupRule.body.error.details.issues.some((i) => i.reason === 'duplicate_incompat_rule'),
    );

    // ---- 8. 合法约束变更：放宽距离到 2，撤销列覆盖与全部类别对 ----
    // 当前两箱距离 3 >= 2，故通过（即便保留距离；这里演示“撤销类别对即相容”）
    const accepted = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '8000',
      columnWeightLimits: [], // 撤销 (1,1) 覆盖
      incompatRules: [], // 撤销 (1,3) 类别对 => 相容
    }, 200);
    check('约束变更受理 revision=2', accepted.body.revision === 2 && accepted.body.previousRevision === 1);
    check(
      '受理后布局原样继承（两箱位置不变）',
      accepted.body.layout.placements.length === 2 &&
        accepted.body.layout.unplacedBoxNos.length === 0,
    );
    const pB1 = accepted.body.layout.placements.find((p) => p.boxNo === 'BOX-1').position;
    check(
      'BOX-1 仍在原位 (1,1,0)',
      pB1.bay === 1 && pB1.row === 1 && pB1.tier === 0,
    );
    check(
      '新约束生效：默认 8000、无覆盖、无类别对',
      accepted.body.layout.defaultColumnWeightLimit === '8000' &&
        accepted.body.layout.columnWeightLimits.length === 0 &&
        accepted.body.layout.incompatRules.length === 0,
    );

    // ---- 9. 历史布局展示当时约束：rev1 仍是旧清单 ----
    const l1 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=1`, undefined, 200)).body;
    check(
      '历史 rev1 展示当时约束（10000/覆盖1200/距离3）',
      l1.defaultColumnWeightLimit === '10000' &&
        l1.columnWeightLimits.length === 1 &&
        l1.columnWeightLimits[0].weightLimit === '1200' &&
        l1.incompatRules.length === 1 &&
        l1.incompatRules[0].minDistance === 3,
    );
    const c1 = (await http('GET', `${BASE}/voyages/${vid}/constraints?rev=1`, undefined, 200)).body;
    check('GET constraints?rev=1 为历史且 current=false', c1.current === false && c1.revision === 1);

    // ---- 10. 后续布局调整继承新约束、且受新约束约束（撤销类别对后可紧邻）----
    const moveAdjacent = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'BOX-2', position: { bay: 1, row: 2, tier: 0 } }], // 紧邻 BOX-1，旧规则距离1<3，新规则相容
    }, 200);
    check('撤销类别对后紧邻合法 revision=3', moveAdjacent.body.revision === 3);
    const l3 = (await http('GET', `${BASE}/voyages/${vid}/layout?rev=3`, undefined, 200)).body;
    check('rev3 继承 rev2 约束（无类别对）', l3.incompatRules.length === 0 && l3.defaultColumnWeightLimit === '8000');

    // 恢复严格类别对后，当前相邻布局不能直接变更回去（复验拦截）
    const restore = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 3,
      defaultColumnWeightLimit: '8000',
      columnWeightLimits: [],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    });
    check('恢复严格类别对时当前相邻布局复验被拒 422', restore.status === 422);

    // ---- 11. 已签发清单 / 在办核对以冻结副本为准，不受新约束影响 ----
    // 当前 BOX-1@(1,1,0) BOX-2@(1,2,0) 相容；签发 rev3
    const manifest = (await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 })).body;
    check('签发 rev3 清单', manifest.revision === 3 && manifest.boxCount === 2);

    // 开核对作业
    const job = (await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 3 }, 201)).body;
    const jobId = job.job.jobId;

    // 作业进行中，即便约束变更成功（当前布局仍相容，换默认承重）也不影响在办核对
    const accept2 = await http('PUT', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 3,
      defaultColumnWeightLimit: '7777',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200);
    check('在办核对期间约束可变更 revision=4', accept2.body.revision === 4);

    // 核对仍按冻结的 rev3 清单：两箱按清单位置上报即可结案
    await http('POST', `${BASE}/check-jobs/${jobId}/reports`, {
      reportNo: 'R1',
      boxNo: 'BOX-1',
      position: { bay: 1, row: 1, tier: 0 },
    }, 201);
    await http('POST', `${BASE}/check-jobs/${jobId}/reports`, {
      reportNo: 'R2',
      boxNo: 'BOX-2',
      position: { bay: 1, row: 2, tier: 0 },
    }, 201);
    const closed = await http('POST', `${BASE}/check-jobs/${jobId}/close`, undefined, 201);
    check(
      '在办核对仍以冻结清单为基准结案成功',
      closed.body.closed === true && closed.body.status.frozen === true,
      JSON.stringify(closed.body),
    );

    // 旧清单内容仍为冻结时布局
    const oldManifest = (await http('GET', `${BASE}/voyages/${vid}/manifests/3`, undefined, 200)).body;
    check('旧清单仍可取且冻结（current=false）', oldManifest.boxCount === 2 && oldManifest.current === false);

    // 约束快照表对 rev4 有完整行，rev0 有初始快照
    const rev0Constraints = (await http('GET', `${BASE}/voyages/${vid}/constraints?rev=0`, undefined, 200)).body;
    check('rev0 初始约束可追溯（登记快照）', rev0Constraints.defaultColumnWeightLimit === '10000');

    // ---- 12. 并发：两个同 baseRevision 的约束变更只有一个成功 ----
    const payload = {
      baseRevision: 4,
      defaultColumnWeightLimit: '6000',
      columnWeightLimits: [],
      incompatRules: [],
    };
    const [a, b] = await Promise.all([
      http('PUT', `${BASE}/voyages/${vid}/constraints`, payload),
      http('PUT', `${BASE}/voyages/${vid}/constraints`, payload),
    ]);
    const stats = [a.status, b.status].sort();
    check('并发约束变更：一个 200 一个 409', stats[0] === 200 && stats[1] === 409, JSON.stringify(stats));

    // ---- 13. 舱位尺寸与箱档案不变（约束变更后 GET 航次/布局几何与箱一致）----
    const after = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check(
      '舱位尺寸与箱档案不变',
      after.geometry.bays === 3 &&
        after.geometry.rows === 2 &&
        after.geometry.tiers === 2 &&
        after.boxes.length === 2 &&
        after.boxes.find((x) => x.boxNo === 'BOX-1').weight === '500',
    );

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
