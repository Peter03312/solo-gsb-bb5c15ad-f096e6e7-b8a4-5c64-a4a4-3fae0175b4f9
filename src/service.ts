import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import {
  BoxInfo,
  ConstraintSpec,
  Geometry,
  Move,
  Placement,
  Position,
  RequestIssue,
  Violation,
  checkConstraintSpec,
  columnKey,
  microToWeight,
  normalizeRulePair,
  ruleKey,
  validateLayout,
  weightToMicro,
  checkMoves,
} from './domain';

/* ---------- DTO ---------- */

export interface ColumnLimitInput {
  bay: number;
  row: number;
  weightLimit: string;
}

export interface BoxInput {
  boxNo: string;
  weight: string;
  category: string;
}

export interface RuleInput {
  categoryA: string;
  categoryB: string;
  minDistance: number;
}

export interface CreateVoyageInput {
  voyageNo: string;
  bays: number;
  rows: number;
  tiers: number;
  defaultColumnWeightLimit: string;
  columnWeightLimits: ColumnLimitInput[];
  boxes: BoxInput[];
  incompatRules: RuleInput[];
}

export interface ApplyMovesInput {
  baseRevision: number;
  moves: Move[];
}

/** 安全约束变更（整组替换，携带所见修订号） */
export interface UpdateConstraintsInput extends ConstraintSpec {
  baseRevision: number;
}

interface VoyageRow {
  id: string;
  voyage_no: string;
  n_bays: number;
  n_rows: number;
  n_tiers: number;
  default_column_limit: bigint;
  rev: number;
  created_at: Date;
}

export interface VoyageJson {
  id: string;
  voyageNo: string;
  bays: number;
  rows: number;
  tiers: number;
  defaultColumnWeightLimit: string;
  revision: number;
  createdAt: string;
}

function voyageToJson(v: VoyageRow): VoyageJson {
  return {
    id: v.id,
    voyageNo: v.voyage_no,
    bays: v.n_bays,
    rows: v.n_rows,
    tiers: v.n_tiers,
    defaultColumnWeightLimit: microToWeight(v.default_column_limit),
    revision: v.rev,
    createdAt: v.created_at.toISOString(),
  };
}

/* ---------- 读取辅助 ---------- */

interface LoadedVoyageData {
  geometry: Geometry;
  boxes: BoxInfo[];
  columnLimits: Map<string, bigint>;
  defaultColumnLimit: bigint;
  rules: Map<string, number>;
  placements: Placement[];
}

async function loadVoyageRow(
  client: PoolClient,
  id: string,
  forUpdate: boolean,
): Promise<VoyageRow | null> {
  const sql = `SELECT id, voyage_no, n_bays, n_rows, n_tiers,
                      default_column_limit::text AS default_column_limit,
                      rev, created_at
               FROM voyages WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`;
  const res = await client.query(sql, [id]);
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, default_column_limit: BigInt(row.default_column_limit as string) };
}

async function loadVoyageData(
  client: PoolClient,
  v: VoyageRow,
  rev: number,
): Promise<LoadedVoyageData> {
  const [boxRes, placeRes] = await Promise.all([
    client.query(
      `SELECT box_no, weight_ug::text AS weight_ug, category FROM boxes WHERE voyage_id=$1 ORDER BY box_no`,
      [v.id],
    ),
    client.query(
      `SELECT box_no, bay, row, tier FROM placements WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
      [v.id, rev],
    ),
  ]);

  const constraints = await loadConstraintsAt(client, v, rev);

  const boxes: BoxInfo[] = boxRes.rows.map((r) => ({
    boxNo: r.box_no as string,
    weight: microToWeight(BigInt(r.weight_ug as string)),
    category: r.category as string,
  }));
  const placements: Placement[] = placeRes.rows.map((r) => ({
    boxNo: r.box_no as string,
    position: { bay: r.bay, row: r.row, tier: r.tier } as Position,
  }));

  return {
    geometry: { bays: v.n_bays, rows: v.n_rows, tiers: v.n_tiers },
    boxes,
    columnLimits: constraints.columnLimits,
    defaultColumnLimit: constraints.defaultColumnLimit,
    rules: constraints.rules,
    placements,
  };
}

/**
 * 读取某修订号【当时生效】的整套安全约束（默认列承重 / 按列覆盖 / 类别对）。
 * 优先取按修订号留痕的快照；对升级前已存在的航次（rev=0 无快照）回退到当前镜像表，
 * 保证旧数据可查。
 */
async function loadConstraintsAt(
  client: PoolClient,
  v: VoyageRow,
  rev: number,
): Promise<{
  defaultColumnLimit: bigint;
  columnLimits: Map<string, bigint>;
  rules: Map<string, number>;
}> {
  const defaultRes = await client.query(
    `SELECT weight_limit::text AS weight_limit FROM voyage_rev_default_limits
     WHERE voyage_id=$1 AND rev=$2`,
    [v.id, rev],
  );
  const hasSnapshot = defaultRes.rows.length > 0;

  if (!hasSnapshot) {
    // 升级前创建的航次只有镜像表数据（通常仅 rev=0）
    const [limitRes, ruleRes] = await Promise.all([
      client.query(
        `SELECT bay, row, weight_limit::text AS weight_limit
         FROM column_weight_limits WHERE voyage_id=$1 ORDER BY bay,row`,
        [v.id],
      ),
      client.query(
        `SELECT cat_a, cat_b, min_distance FROM incompat_rules WHERE voyage_id=$1 ORDER BY cat_a,cat_b`,
        [v.id],
      ),
    ]);
    const columnLimits = new Map<string, bigint>();
    for (const r of limitRes.rows) {
      columnLimits.set(columnKey(r.bay as number, r.row as number), BigInt(r.weight_limit as string));
    }
    const rules = new Map<string, number>();
    for (const r of ruleRes.rows) {
      rules.set(ruleKey(r.cat_a as string, r.cat_b as string), Number(r.min_distance));
    }
    return { defaultColumnLimit: v.default_column_limit, columnLimits, rules };
  }

  const [limitRes, ruleRes] = await Promise.all([
    client.query(
      `SELECT bay, row, weight_limit::text AS weight_limit
       FROM voyage_rev_column_limits WHERE voyage_id=$1 AND rev=$2 ORDER BY bay,row`,
      [v.id, rev],
    ),
    client.query(
      `SELECT cat_a, cat_b, min_distance
       FROM voyage_rev_incompat_rules WHERE voyage_id=$1 AND rev=$2 ORDER BY cat_a,cat_b`,
      [v.id, rev],
    ),
  ]);
  const defaultColumnLimit = BigInt(defaultRes.rows[0].weight_limit as string);
  const columnLimits = new Map<string, bigint>();
  for (const r of limitRes.rows) {
    columnLimits.set(columnKey(r.bay as number, r.row as number), BigInt(r.weight_limit as string));
  }
  const rules = new Map<string, number>();
  for (const r of ruleRes.rows) {
    rules.set(ruleKey(r.cat_a as string, r.cat_b as string), Number(r.min_distance));
  }
  return { defaultColumnLimit, columnLimits, rules };
}

/* ---------- 业务操作 ---------- */

/** 约束清单（正数/坐标/唯一性）不通过时抛 400；登记与约束变更共用 */
function assertConstraintSpec(spec: ConstraintSpec, geometry: Geometry): void {
  const issues = checkConstraintSpec(spec, geometry);
  if (issues.length > 0) {
    throw HttpError.invalidRequest(
      'invalid_constraints',
      '安全约束清单校验未通过（列坐标越界 / 列覆盖重复 / 类别对重复），已拒绝',
      { issueCount: issues.length, issues },
    );
  }
}

/** 归一化一组不相容类别规则（categoryA <= categoryB） */
function normalizeRules(
  rules: RuleInput[],
): { categoryA: string; categoryB: string; minDistance: number }[] {
  return rules.map((r) => ({ ...normalizeRulePair(r.categoryA, r.categoryB), minDistance: r.minDistance }));
}

export class VoyageService {
  constructor(private readonly pool: Pool) {}

  async createVoyage(input: CreateVoyageInput): Promise<VoyageJson> {
    const geometry: Geometry = { bays: input.bays, rows: input.rows, tiers: input.tiers };

    // 登记时约束校验：列承重坐标、列覆盖唯一性、类别对唯一性（沿用至约束变更）
    assertConstraintSpec(
      {
        defaultColumnWeightLimit: input.defaultColumnWeightLimit,
        columnWeightLimits: input.columnWeightLimits,
        incompatRules: input.incompatRules,
      },
      geometry,
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let v: VoyageRow;
      try {
        const res = await client.query(
          `INSERT INTO voyages
             (voyage_no, n_bays, n_rows, n_tiers, default_column_limit, rev)
           VALUES ($1,$2,$3,$4,$5,0)
           RETURNING id, voyage_no, n_bays, n_rows, n_tiers,
                     default_column_limit::text AS default_column_limit, rev, created_at`,
          [
            input.voyageNo,
            input.bays,
            input.rows,
            input.tiers,
            weightToMicro(input.defaultColumnWeightLimit).toString(),
          ],
        );
        v = {
          ...res.rows[0],
          default_column_limit: BigInt(res.rows[0].default_column_limit),
        } as VoyageRow;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw HttpError.badRequest(
            'voyage_no_exists',
            `航次号 ${input.voyageNo} 已登记`,
          );
        }
        throw err;
      }

      if (input.columnWeightLimits.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id];
        let i = 2;
        for (const l of input.columnWeightLimits) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          params.push(l.bay, l.row, weightToMicro(l.weightLimit).toString());
        }
        await client.query(
          `INSERT INTO column_weight_limits (voyage_id, bay, row, weight_limit) VALUES ${values.join(',')}`,
          params,
        );
      }

      if (input.boxes.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id];
        let i = 2;
        for (const b of input.boxes) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          params.push(b.boxNo, weightToMicro(b.weight).toString(), b.category);
        }
        await client.query(
          `INSERT INTO boxes (voyage_id, box_no, weight_ug, category) VALUES ${values.join(',')}`,
          params,
        );
      }

      if (input.incompatRules.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id];
        let i = 2;
        for (const r of normalizeRules(input.incompatRules)) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          params.push(r.categoryA, r.categoryB, r.minDistance);
        }
        await client.query(
          `INSERT INTO incompat_rules (voyage_id, cat_a, cat_b, min_distance) VALUES ${values.join(',')}`,
          params,
        );
      }

      // rev=0 约束快照（按修订号留痕，供历史布局展示当时生效的约束）
      await this.insertConstraintSnapshots(client, v.id, 0, {
        defaultColumnWeightLimit: input.defaultColumnWeightLimit,
        columnWeightLimits: input.columnWeightLimits,
        incompatRules: normalizeRules(input.incompatRules),
      });

      await client.query('COMMIT');
      return voyageToJson(v);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 写入某修订号生效的整套约束快照：默认列承重 + 按列覆盖 + 不相容类别对。
   * 约束已通过 checkConstraintSpec（坐标/唯一性）校验，类别对已归一化。
   */
  private async insertConstraintSnapshots(
    client: PoolClient,
    voyageId: string,
    rev: number,
    spec: ConstraintSpec,
  ): Promise<void> {
    await client.query(
      `INSERT INTO voyage_rev_default_limits (voyage_id, rev, weight_limit)
       VALUES ($1, $2, $3)`,
      [voyageId, rev, weightToMicro(spec.defaultColumnWeightLimit).toString()],
    );

    if (spec.columnWeightLimits.length > 0) {
      const values: string[] = [];
      const params: (string | number)[] = [voyageId, rev];
      let i = 3;
      for (const l of spec.columnWeightLimits) {
        values.push(`($1, $2, $${i++}, $${i++}, $${i++})`);
        params.push(l.bay, l.row, weightToMicro(l.weightLimit).toString());
      }
      await client.query(
        `INSERT INTO voyage_rev_column_limits (voyage_id, rev, bay, row, weight_limit)
         VALUES ${values.join(',')}`,
        params,
      );
    }

    if (spec.incompatRules.length > 0) {
      const values: string[] = [];
      const params: (string | number)[] = [voyageId, rev];
      let i = 3;
      for (const r of spec.incompatRules) {
        const pair = normalizeRulePair(r.categoryA, r.categoryB);
        values.push(`($1, $2, $${i++}, $${i++}, $${i++})`);
        params.push(pair.categoryA, pair.categoryB, r.minDistance);
      }
      await client.query(
        `INSERT INTO voyage_rev_incompat_rules (voyage_id, rev, cat_a, cat_b, min_distance)
         VALUES ${values.join(',')}`,
        params,
      );
    }
  }

  /**
   * 确保当前修订号存在约束快照（升级前创建的旧航次 rev=0 无快照）：
   * 缺则以当前镜像表（voyages 默认承重 + column_weight_limits + incompat_rules）补齐。
   * 必须在持有航次行锁的事务内、且当前修订号尚未发生任何变更前调用，
   * 这样随后替换镜像表也不会污染历史修订号的查询结果。
   */
  private async ensureConstraintSnapshot(client: PoolClient, v: VoyageRow): Promise<void> {
    const exists = await client.query(
      `SELECT 1 FROM voyage_rev_default_limits WHERE voyage_id=$1 AND rev=$2`,
      [v.id, v.rev],
    );
    if (exists.rows.length > 0) return;

    await client.query(
      `INSERT INTO voyage_rev_default_limits (voyage_id, rev, weight_limit)
       VALUES ($1, $2, $3)`,
      [v.id, v.rev, v.default_column_limit.toString()],
    );
    await client.query(
      `INSERT INTO voyage_rev_column_limits (voyage_id, rev, bay, row, weight_limit)
       SELECT $1, $2, bay, row, weight_limit FROM column_weight_limits WHERE voyage_id=$1`,
      [v.id, v.rev],
    );
    await client.query(
      `INSERT INTO voyage_rev_incompat_rules (voyage_id, rev, cat_a, cat_b, min_distance)
       SELECT $1, $2, cat_a, cat_b, min_distance FROM incompat_rules WHERE voyage_id=$1`,
      [v.id, v.rev],
    );
  }

  async listVoyages(): Promise<VoyageJson[]> {
    const res = await this.pool.query(
      `SELECT id, voyage_no, n_bays, n_rows, n_tiers,
              default_column_limit::text AS default_column_limit, rev, created_at
       FROM voyages ORDER BY created_at DESC, voyage_no`,
    );
    return res.rows.map(
      (r): VoyageJson => ({
        ...voyageToJson({
          ...r,
          default_column_limit: BigInt(r.default_column_limit),
        } as VoyageRow),
      }),
    );
  }

  async getVoyage(id: string): Promise<VoyageJson> {
    const res = await this.pool.query(
      `SELECT id, voyage_no, n_bays, n_rows, n_tiers,
              default_column_limit::text AS default_column_limit, rev, created_at
       FROM voyages WHERE id=$1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
    return voyageToJson({
      ...row,
      default_column_limit: BigInt(row.default_column_limit),
    } as VoyageRow);
  }

  /** 查询某修订号布局（rev 缺省为当前修订号） */
  async getLayout(id: string, rev?: number) {
    const client = await this.pool.connect();
    try {
      const v = await loadVoyageRow(client, id, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      if (rev !== undefined) {
        if (!Number.isInteger(rev) || rev < 0) {
          throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
        }
        if (rev > v.rev) {
          throw HttpError.notFound(
            'revision_not_found',
            `修订号 ${rev} 不存在，当前修订号为 ${v.rev}`,
          );
        }
      }
      const wanted = rev ?? v.rev;
      const data = await loadVoyageData(client, v, wanted);
      return this.serializeLayout(v, wanted, data);
    } finally {
      client.release();
    }
  }

  /** 查询某修订号生效的安全约束（rev 缺省为当前修订号；历史修订号返回当时清单） */
  async getConstraints(id: string, rev?: number) {
    const client = await this.pool.connect();
    try {
      const v = await loadVoyageRow(client, id, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      if (rev !== undefined) {
        if (!Number.isInteger(rev) || rev < 0) {
          throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
        }
        if (rev > v.rev) {
          throw HttpError.notFound(
            'revision_not_found',
            `修订号 ${rev} 不存在，当前修订号为 ${v.rev}`,
          );
        }
      }
      const wanted = rev ?? v.rev;
      const data = await loadVoyageData(client, v, wanted);
      return {
        voyageId: v.id,
        voyageNo: v.voyage_no,
        revision: wanted,
        current: wanted === v.rev,
        geometry: data.geometry,
        defaultColumnWeightLimit: microToWeight(data.defaultColumnLimit),
        columnWeightLimits: [...data.columnLimits.entries()]
          .map(([key, limit]) => {
            const parts = key.split('/');
            return {
              bay: Number(parts[0]),
              row: Number(parts[1]),
              weightLimit: microToWeight(limit),
            };
          })
          .sort((a, b) => a.bay - b.bay || a.row - b.row),
        incompatRules: [...data.rules.entries()]
          .map(([key, minDistance]) => {
            const parts = key.split('|');
            return { categoryA: parts[0] ?? '', categoryB: parts[1] ?? '', minDistance };
          })
          .sort((a, b) => a.categoryA.localeCompare(b.categoryA) || a.categoryB.localeCompare(b.categoryB)),
      };
    } finally {
      client.release();
    }
  }

  private serializeLayout(v: VoyageRow, rev: number, data: LoadedVoyageData) {
    const placedBoxNos = new Set(data.placements.map((p) => p.boxNo));
    return {
      voyageId: v.id,
      voyageNo: v.voyage_no,
      revision: rev,
      current: rev === v.rev,
      geometry: data.geometry,
      defaultColumnWeightLimit: microToWeight(data.defaultColumnLimit),
      columnWeightLimits: [...data.columnLimits.entries()].map(([key, limit]) => {
        const [bay, row] = key.split('/').map(Number);
        return { bay, row, weightLimit: microToWeight(limit) };
      }),
      boxes: data.boxes,
      incompatRules: [...data.rules.entries()].map(([key, minDistance]) => {
        const [categoryA, categoryB] = key.split('|');
        return { categoryA, categoryB, minDistance };
      }),
      placements: data.placements
        .map((p) => ({ boxNo: p.boxNo, position: p.position }))
        .sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
      unplacedBoxNos: data.boxes
        .filter((b) => !placedBoxNos.has(b.boxNo))
        .map((b) => b.boxNo),
    };
  }

  /**
   * 携带所见修订号整批调整。同批可交换（先撤后放仅用于计算最终布局，
   * 校验只针对最终布局）。任一规则违反则整批拒绝。
   */
  async applyMoves(id: string, input: ApplyMovesInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const v = await loadVoyageRow(client, id, true);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      }
      if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
        throw HttpError.badRequest('invalid_revision', 'baseRevision 必须为非负整数');
      }
      if (v.rev !== input.baseRevision) {
        throw HttpError.staleRevision(v.rev, input.baseRevision);
      }

      // 升级前的旧航次当前修订号可能缺约束快照，先按当前镜像补齐（保证历史可追溯）
      await this.ensureConstraintSnapshot(client, v);

      const data = await loadVoyageData(client, v, v.rev);

      // 请求级错误：未知箱 / 无效坐标 / 同批重复箱号
      const knownBoxes = new Set(data.boxes.map((b) => b.boxNo));
      const requestIssues: RequestIssue[] = checkMoves(input.moves, data.geometry, knownBoxes);
      if (requestIssues.length > 0) {
        throw HttpError.invalidRequest(
          'invalid_adjustment',
          '整批调整请求包含非法指令，已拒绝',
          { issueCount: requestIssues.length, issues: requestIssues },
        );
      }

      // 以“最终布局”为基准应用整批指令（撤位=null；未出现的箱保持原位）
      const finalPositions = new Map<string, Position | null>();
      for (const p of data.placements) finalPositions.set(p.boxNo, p.position);
      for (const move of input.moves) {
        if (move.position === null) finalPositions.set(move.boxNo, null);
        else finalPositions.set(move.boxNo, move.position);
      }
      const finalPlacements: Placement[] = [...finalPositions.entries()]
        .filter((entry): entry is [string, Position] => entry[1] !== null)
        .map(([boxNo, position]) => ({ boxNo, position }));

      // 规则校验：任何违反整批拒绝
      const violations: Violation[] = validateLayout({
        geometry: data.geometry,
        boxes: data.boxes,
        placements: finalPlacements,
        columnLimits: data.columnLimits,
        defaultColumnLimit: data.defaultColumnLimit,
        rules: data.rules,
      });
      if (violations.length > 0) {
        throw HttpError.validationFailed(violations);
      }

      const nextRev = v.rev + 1;
      if (finalPlacements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id, nextRev];
        let i = 3;
        for (const p of finalPlacements) {
          values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO placements (voyage_id, rev, box_no, bay, row, tier) VALUES ${values.join(',')}`,
          params,
        );
      }

      // 布局调整不改变约束：新修订号原样继承当前生效约束快照
      await client.query(
        `INSERT INTO voyage_rev_default_limits (voyage_id, rev, weight_limit)
           SELECT $2 AS voyage_id, $1 AS rev, weight_limit FROM voyage_rev_default_limits
           WHERE voyage_id=$2 AND rev=$3`,
        [nextRev, v.id, v.rev],
      );
      await client.query(
        `INSERT INTO voyage_rev_column_limits (voyage_id, rev, bay, row, weight_limit)
           SELECT $1, $2, bay, row, weight_limit FROM voyage_rev_column_limits
           WHERE voyage_id=$1 AND rev=$3`,
        [v.id, nextRev, v.rev],
      );
      await client.query(
        `INSERT INTO voyage_rev_incompat_rules (voyage_id, rev, cat_a, cat_b, min_distance)
           SELECT $1, $2, cat_a, cat_b, min_distance FROM voyage_rev_incompat_rules
           WHERE voyage_id=$1 AND rev=$3`,
        [v.id, nextRev, v.rev],
      );

      await client.query(`UPDATE voyages SET rev=$2 WHERE id=$1`, [v.id, nextRev]);

      await client.query('COMMIT');

      const newData: LoadedVoyageData = { ...data, placements: finalPlacements };
      return {
        revision: nextRev,
        previousRevision: v.rev,
        applied: input.moves.length,
        layout: this.serializeLayout({ ...v, rev: nextRev }, nextRev, newData),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 变更航次安全约束（整组替换，携带所见 baseRevision）：
   *  - 提交即【整套】默认列承重 + 按列覆盖限额 + 不相容类别对最小距离；
   *    未列出的覆盖项 / 类别对即撤销；舱位尺寸与箱档案不变。
   *  - 沿用登记时的正数重量、列坐标范围及类别对唯一性校验。
   *  - 受理前以新约束对【当前完整布局】复验；任一配载规则违反则 422 整批拒绝，
   *    返回箱号、舱位与原因，规则与修订号均不变。
   *  - baseRevision 过期（与当前修订号不一致）→ 409 stale_revision 并带回当前修订号。
   *  - 受理后修订号 +1：写入新约束快照，布局原样继承（placements 复制到新修订号），
   *    同时更新当前镜像表保持既有接口字段兼容。
   *  - 历史布局按修订号展示当时生效约束；已签发清单 / 在办核对仍以各自冻结副本为准。
   */
  async updateConstraints(id: string, input: UpdateConstraintsInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const v = await loadVoyageRow(client, id, true);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      }
      if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
        throw HttpError.badRequest('invalid_revision', 'baseRevision 必须为非负整数');
      }
      if (v.rev !== input.baseRevision) {
        throw HttpError.staleRevision(v.rev, input.baseRevision);
      }

      const geometry: Geometry = { bays: v.n_bays, rows: v.n_rows, tiers: v.n_tiers };

      // 1) 请求级校验（与登记一致）：列坐标越界 / 列覆盖重复 / 类别对重复
      const newSpec: ConstraintSpec = {
        defaultColumnWeightLimit: input.defaultColumnWeightLimit,
        columnWeightLimits: input.columnWeightLimits,
        incompatRules: normalizeRules(input.incompatRules),
      };
      assertConstraintSpec(newSpec, geometry);

      // 升级前的旧航次当前修订号可能缺约束快照：在替换镜像表前先补齐，
      // 否则历史 rev=0 会错误回显新约束
      await this.ensureConstraintSnapshot(client, v);

      const currentData = await loadVoyageData(client, v, v.rev);

      // 2) 受理前以新约束复验当前完整布局；任何违反整批拒绝（规则/修订号不变）
      const newColumnLimits = new Map<string, bigint>();
      for (const l of input.columnWeightLimits) {
        newColumnLimits.set(columnKey(l.bay, l.row), weightToMicro(l.weightLimit));
      }
      const newRules = new Map<string, number>();
      for (const r of newSpec.incompatRules) {
        newRules.set(ruleKey(r.categoryA, r.categoryB), r.minDistance);
      }
      const violations: Violation[] = validateLayout({
        geometry,
        boxes: currentData.boxes,
        placements: currentData.placements,
        columnLimits: newColumnLimits,
        defaultColumnLimit: weightToMicro(input.defaultColumnWeightLimit),
        rules: newRules,
      });
      if (violations.length > 0) {
        throw HttpError.validationFailed(violations);
      }

      // 3) 受理：rev+1；布局原样继承
      const nextRev = v.rev + 1;

      // 3a) 当前完整布局复制到新修订号
      if (currentData.placements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id, nextRev];
        let i = 3;
        for (const p of currentData.placements) {
          values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO placements (voyage_id, rev, box_no, bay, row, tier) VALUES ${values.join(',')}`,
          params,
        );
      }

      // 3b) 写入新修订号的约束快照
      await this.insertConstraintSnapshots(client, v.id, nextRev, newSpec);

      // 3c) 更新当前镜像表（整组替换：未列出的覆盖项/类别对删除）
      await client.query(
        `UPDATE voyages SET default_column_limit=$2, rev=$3 WHERE id=$1`,
        [v.id, weightToMicro(input.defaultColumnWeightLimit).toString(), nextRev],
      );
      await client.query(`DELETE FROM column_weight_limits WHERE voyage_id=$1`, [v.id]);
      if (input.columnWeightLimits.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id];
        let i = 2;
        for (const l of input.columnWeightLimits) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          params.push(l.bay, l.row, weightToMicro(l.weightLimit).toString());
        }
        await client.query(
          `INSERT INTO column_weight_limits (voyage_id, bay, row, weight_limit) VALUES ${values.join(',')}`,
          params,
        );
      }
      await client.query(`DELETE FROM incompat_rules WHERE voyage_id=$1`, [v.id]);
      if (newSpec.incompatRules.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id];
        let i = 2;
        for (const r of newSpec.incompatRules) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          params.push(r.categoryA, r.categoryB, r.minDistance);
        }
        await client.query(
          `INSERT INTO incompat_rules (voyage_id, cat_a, cat_b, min_distance) VALUES ${values.join(',')}`,
          params,
        );
      }

      await client.query('COMMIT');

      const newVoyage: VoyageRow = {
        ...v,
        default_column_limit: weightToMicro(input.defaultColumnWeightLimit),
        rev: nextRev,
      };
      const newData: LoadedVoyageData = {
        ...currentData,
        defaultColumnLimit: weightToMicro(input.defaultColumnWeightLimit),
        columnLimits: newColumnLimits,
        rules: newRules,
      };
      return {
        revision: nextRev,
        previousRevision: v.rev,
        layout: this.serializeLayout(newVoyage, nextRev, newData),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 签发装载清单：所有箱必须已配位；内容冻结到 expectedRevision 的布局。
   * expectedRevision 必须等于当前修订号，防止为过期布局签发“当前清单”。
   * 对同一修订号重复签发幂等返回既有清单。
   */
  async issueManifest(id: string, expectedRevision: number) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const v = await loadVoyageRow(client, id, true);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      }
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw HttpError.badRequest('invalid_revision', 'expectedRevision 必须为非负整数');
      }
      if (v.rev !== expectedRevision) {
        throw HttpError.staleRevision(v.rev, expectedRevision);
      }

      // 幂等：该修订号已签发则直接返回旧清单
      const existing = await client.query(
        `SELECT rev, issued_at, box_count FROM manifests WHERE voyage_id=$1 AND rev=$2`,
        [v.id, v.rev],
      );
      if (existing.rows.length === 1) {
        const items = await this.loadManifestItems(client, v.id, v.rev);
        await client.query('COMMIT');
        return {
          reused: true,
          manifest: this.manifestToJson(v.id, v.rev, existing.rows[0].issued_at, Number(existing.rows[0].box_count), true, items),
        };
      }

      const data = await loadVoyageData(client, v, v.rev);

      // 所有箱必须已配位
      const placedBoxNos = new Set(data.placements.map((p) => p.boxNo));
      const unplaced = data.boxes.filter((b) => !placedBoxNos.has(b.boxNo)).map((b) => b.boxNo);
      if (unplaced.length > 0) {
        throw new HttpError(
          422,
          'unplaced_boxes',
          `尚有 ${unplaced.length} 个箱未配位，无法签发装载清单`,
          { unplacedBoxNos: unplaced },
        );
      }

      // 防御性复验（布局仅由 applyMoves 产生，正常不会触发）
      const violations = validateLayout({
        geometry: data.geometry,
        boxes: data.boxes,
        placements: data.placements,
        columnLimits: data.columnLimits,
        defaultColumnLimit: data.defaultColumnLimit,
        rules: data.rules,
      });
      if (violations.length > 0) {
        throw HttpError.validationFailed(violations);
      }

      await client.query(
        `INSERT INTO manifests (voyage_id, rev, box_count) VALUES ($1,$2,$3)`,
        [v.id, v.rev, data.placements.length],
      );
      if (data.placements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id, v.rev];
        let i = 3;
        for (const p of data.placements) {
          values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO manifest_items (voyage_id, rev, box_no, bay, row, tier) VALUES ${values.join(',')}`,
          params,
        );
      }

      await client.query('COMMIT');
      return {
        reused: false,
        manifest: this.manifestToJson(v.id, v.rev, new Date(), data.placements.length, true, data.placements),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadManifestItems(
    client: PoolClient,
    voyageId: string,
    rev: number,
  ): Promise<Placement[]> {
    const res = await client.query(
      `SELECT box_no, bay, row, tier FROM manifest_items WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
      [voyageId, rev],
    );
    return res.rows.map(
      (r): Placement => ({
        boxNo: r.box_no,
        position: { bay: r.bay, row: r.row, tier: r.tier },
      }),
    );
  }

  private manifestToJson(
    voyageId: string,
    rev: number,
    issuedAt: Date,
    boxCount: number,
    current: boolean,
    items: Placement[],
  ) {
    return {
      voyageId,
      revision: rev,
      issuedAt: issuedAt.toISOString(),
      boxCount,
      current,
      items: items.map((p) => ({ boxNo: p.boxNo, position: p.position })),
    };
  }

  async listManifests(id: string) {
    // 确认航次存在
    await this.getVoyage(id);
    const res = await this.pool.query(
      `SELECT m.rev, m.issued_at, m.box_count, v.rev AS current_rev,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'boxNo', mi.box_no,
                  'position', json_build_object('bay', mi.bay, 'row', mi.row, 'tier', mi.tier)
                ) ORDER BY mi.box_no)
                FROM manifest_items mi
                WHERE mi.voyage_id = m.voyage_id AND mi.rev = m.rev
              ), '[]'::json) AS items
       FROM manifests m JOIN voyages v ON v.id = m.voyage_id
       WHERE m.voyage_id=$1
       ORDER BY m.rev DESC`,
      [id],
    );
    return res.rows.map((r) => ({
      voyageId: id,
      revision: Number(r.rev),
      issuedAt: new Date(r.issued_at).toISOString(),
      boxCount: Number(r.box_count),
      current: Number(r.rev) === Number(r.current_rev),
      items: r.items as Array<{ boxNo: string; position: Position }>,
    }));
  }

  async getManifest(id: string, rev: number) {
    const client = await this.pool.connect();
    try {
      const v = await loadVoyageRow(client, id, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${id} 不存在`);
      if (!Number.isInteger(rev) || rev < 0) {
        throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
      }
      const res = await client.query(
        `SELECT rev, issued_at, box_count FROM manifests WHERE voyage_id=$1 AND rev=$2`,
        [id, rev],
      );
      if (res.rows.length === 0) {
        throw HttpError.notFound('manifest_not_found', `航次 ${id} 在修订号 ${rev} 没有已签发的装载清单`);
      }
      const items = await this.loadManifestItems(client, id, rev);
      return this.manifestToJson(
        id,
        rev,
        res.rows[0].issued_at,
        Number(res.rows[0].box_count),
        rev === v.rev,
        items,
      );
    } finally {
      client.release();
    }
  }
}
