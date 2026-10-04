import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoxInfo,
  ConstraintSpec,
  Geometry,
  Move,
  Placement,
  Position,
  checkConstraintSpec,
  checkMoves,
  manhattan,
  microToWeight,
  normalizeRulePair,
  ruleKey,
  validateLayout,
  weightToMicro,
} from '../src/domain';

const g: Geometry = { bays: 4, rows: 2, tiers: 3 };

const boxes: BoxInfo[] = [
  { boxNo: 'A', weight: '1000', category: '1.1' },
  { boxNo: 'B', weight: '1000', category: '1.1' },
  { boxNo: 'C', weight: '500', category: '3' },
];

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

const rules = new Map([[ruleKey('1.1', '1.1'), 4]]);
const limits = new Map<string, bigint>();

test('重量十进制换算精确', () => {
  assert.equal(weightToMicro('1000'), 1_000_000_000n);
  assert.equal(weightToMicro('0.000001'), 1n);
  assert.equal(microToWeight(weightToMicro('12.34')), '12.34');
});

test('曼哈顿距离', () => {
  assert.equal(manhattan(pos(1, 1, 0), pos(2, 1, 0)), 1);
  assert.equal(manhattan(pos(1, 1, 0), pos(3, 2, 1)), 4);
});

test('合规布局通过', () => {
  const placements: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(3, 1, 0) }, // 距离 2 < 4? bay 差 2 => 不通过
  ];
  const v1 = validateLayout({ geometry: g, boxes, placements, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules });
  assert.equal(v1.length, 1);
  assert.equal(v1[0]!.reason, 'incompatible_too_close');
  assert.equal(v1[0]!.distance, 2);
});

test('距离达标后通过', () => {
  const placements: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(4, 2, 0) }, // |3|+|1|+0 = 4 >= 4
  ];
  const violations = validateLayout({ geometry: g, boxes, placements, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules });
  assert.deepEqual(violations, []);
});

test('同列必须自底向上连续：tier1 悬空被拒', () => {
  const placements: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 1) },
  ];
  const v = validateLayout({ geometry: g, boxes, placements, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.reason, 'column_not_continuous');
  assert.deepEqual((v[0] as { missingTiers: number[] }).missingTiers, [0]);
});

test('tier0,tier1,tier2 连续通过；中间缺层被拒', () => {
  const ok: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(1, 1, 1) },
    { boxNo: 'C', position: pos(1, 1, 2) },
  ];
  assert.equal(
    validateLayout({ geometry: g, boxes, placements: ok, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() }).length,
    0,
  );
  const bad: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'C', position: pos(1, 1, 2) },
  ];
  const v = validateLayout({ geometry: g, boxes, placements: bad, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.equal(v[0]!.reason, 'column_not_continuous');
});

test('列总重量超限被拒（默认上限与单独上限）', () => {
  const placements: Placement[] = [{ boxNo: 'A', position: pos(1, 1, 0) }];
  const v = validateLayout({ geometry: g, boxes, placements, columnLimits: limits, defaultColumnLimit: 999_000_000n, rules: new Map() });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.reason, 'column_overweight');
  assert.equal((v[0] as { totalWeight: string }).totalWeight, '1000');

  const custom = new Map([['1/1', 500_000_000n]]);
  const v2 = validateLayout({ geometry: g, boxes, placements, columnLimits: custom, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.equal(v2[0]!.reason, 'column_overweight');
});

test('一箱多位 / 一位多箱被拒', () => {
  const dupBox: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'A', position: pos(2, 1, 0) },
  ];
  const v1 = validateLayout({ geometry: g, boxes, placements: dupBox, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.ok(v1.some((x) => x.reason === 'box_duplicated'));

  const collision: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(1, 1, 0) },
  ];
  const v2 = validateLayout({ geometry: g, boxes, placements: collision, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.ok(v2.some((x) => x.reason === 'position_collision'));
});

test('整批交换在最终布局下合法：不产生冲突', () => {
  // A 在 (1,1,0)，B 在 (1,1,1)，交换后仍连续、无冲突
  const swapped: Placement[] = [
    { boxNo: 'A', position: pos(1, 1, 1) },
    { boxNo: 'B', position: pos(1, 1, 0) },
  ];
  const v = validateLayout({ geometry: g, boxes, placements: swapped, columnLimits: limits, defaultColumnLimit: 10_000_000_000n, rules: new Map() });
  assert.deepEqual(v, []);
});

test('checkMoves: 未知箱 / 越界坐标 / 同批重复', () => {
  const moves: Move[] = [
    { boxNo: 'UNKNOWN', position: pos(1, 1, 0) },
    { boxNo: 'A', position: pos(99, 1, 0) },
    { boxNo: 'B', position: pos(1, 1, 0) },
    { boxNo: 'B', position: pos(2, 1, 0) },
  ];
  const issues = checkMoves(moves, g, new Set(['A', 'B', 'C']));
  const reasons = issues.map((i) => i.reason);
  assert.ok(reasons.includes('unknown_box'));
  assert.ok(reasons.includes('invalid_coordinates'));
  assert.ok(reasons.includes('duplicate_box_in_batch'));
});

test('撤位 position=null 合法', () => {
  const issues = checkMoves([{ boxNo: 'A', position: null }], g, new Set(['A']));
  assert.deepEqual(issues, []);
});

test('checkConstraintSpec: 合法整套约束无问题', () => {
  const spec: ConstraintSpec = {
    defaultColumnWeightLimit: '10000',
    columnWeightLimits: [
      { bay: 1, row: 1, weightLimit: '1200' },
      { bay: 4, row: 2, weightLimit: '999.5' },
    ],
    incompatRules: [
      { categoryA: '1', categoryB: '3', minDistance: 3 },
      { categoryA: '5', categoryB: '2', minDistance: 1 }, // 提交时无序
    ],
  };
  assert.deepEqual(checkConstraintSpec(spec, g), []);
});

test('checkConstraintSpec: 列坐标越界 / 列覆盖重复 / 类别对重复（归一化后）', () => {
  const spec: ConstraintSpec = {
    defaultColumnWeightLimit: '10000',
    columnWeightLimits: [
      { bay: 5, row: 1, weightLimit: '1200' }, // 越界（bays=4）
      { bay: 1, row: 1, weightLimit: '1200' },
      { bay: 1, row: 1, weightLimit: '1300' }, // 同列重复
    ],
    incompatRules: [
      { categoryA: '3', categoryB: '1', minDistance: 2 },
      { categoryA: '1', categoryB: '3', minDistance: 3 }, // 归一化后与上者重复
    ],
  };
  const issues = checkConstraintSpec(spec, g);
  const reasons = issues.map((i) => i.reason);
  assert.ok(reasons.includes('invalid_column_limit'));
  assert.ok(reasons.includes('duplicate_column_limit'));
  assert.ok(reasons.includes('duplicate_incompat_rule'));
});

test('normalizeRulePair: 类别对归一化与顺序无关', () => {
  assert.deepEqual(normalizeRulePair('3', '1'), { categoryA: '1', categoryB: '3' });
  assert.deepEqual(normalizeRulePair('1', '3'), { categoryA: '1', categoryB: '3' });
  assert.equal(ruleKey('3', '1'), '1|3');
});
