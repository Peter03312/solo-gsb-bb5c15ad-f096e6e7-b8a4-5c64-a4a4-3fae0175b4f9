import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import {
  BoxInfo,
  Geometry,
  Move,
  Placement,
  Position,
  RequestIssue,
  Violation,
  columnKey,
  microToWeight,
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
  const [boxRes, limitRes, ruleRes, placeRes] = await Promise.all([
    client.query(
      `SELECT box_no, weight_ug::text AS weight_ug, category FROM boxes WHERE voyage_id=$1 ORDER BY box_no`,
      [v.id],
    ),
    client.query(
      `SELECT bay, row, weight_limit::text AS weight_limit FROM column_weight_limits WHERE voyage_id=$1 ORDER BY bay,row`,
      [v.id],
    ),
    client.query(
      `SELECT cat_a, cat_b, min_distance FROM incompat_rules WHERE voyage_id=$1 ORDER BY cat_a,cat_b`,
      [v.id],
    ),
    client.query(
      `SELECT box_no, bay, row, tier FROM placements WHERE voyage_id=$1 AND rev=$2 ORDER BY box_no`,
      [v.id, rev],
    ),
  ]);

  const boxes: BoxInfo[] = boxRes.rows.map((r) => ({
    boxNo: r.box_no as string,
    weight: microToWeight(BigInt(r.weight_ug as string)),
    category: r.category as string,
  }));
  const columnLimits = new Map<string, bigint>();
  for (const r of limitRes.rows) {
    columnLimits.set(columnKey(r.bay as number, r.row as number), BigInt(r.weight_limit as string));
  }
  const rules = new Map<string, number>();
  for (const r of ruleRes.rows) {
    rules.set(ruleKey(r.cat_a as string, r.cat_b as string), Number(r.min_distance));
  }
  const placements: Placement[] = placeRes.rows.map((r) => ({
    boxNo: r.box_no as string,
    position: { bay: r.bay, row: r.row, tier: r.tier } as Position,
  }));

  return {
    geometry: { bays: v.n_bays, rows: v.n_rows, tiers: v.n_tiers },
    boxes,
    columnLimits,
    defaultColumnLimit: v.default_column_limit,
    rules,
    placements,
  };
}

/* ---------- 业务操作 ---------- */

export class VoyageService {
  constructor(private readonly pool: Pool) {}

  async createVoyage(input: CreateVoyageInput): Promise<VoyageJson> {
    const geometry: Geometry = { bays: input.bays, rows: input.rows, tiers: input.tiers };

    // 登记时校验列承重坐标
    const badLimit = input.columnWeightLimits.find(
      (l) =>
        !Number.isInteger(l.bay) ||
        !Number.isInteger(l.row) ||
        l.bay < 1 ||
        l.bay > geometry.bays ||
        l.row < 1 ||
        l.row > geometry.rows,
    );
    if (badLimit) {
      throw HttpError.badRequest(
        'invalid_column_limit',
        `列承重配置坐标 (bay=${badLimit.bay}, row=${badLimit.row}) 超出舱位范围`,
        badLimit,
      );
    }

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
        for (const r of input.incompatRules) {
          values.push(`($1, $${i++}, $${i++}, $${i++})`);
          const [a, b] =
            r.categoryA <= r.categoryB ? [r.categoryA, r.categoryB] : [r.categoryB, r.categoryA];
          params.push(a, b, r.minDistance);
        }
        try {
          await client.query(
            `INSERT INTO incompat_rules (voyage_id, cat_a, cat_b, min_distance) VALUES ${values.join(',')}`,
            params,
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw HttpError.badRequest(
              'duplicate_incompat_rule',
              '存在重复的不相容类别对，每对至多设定一个最小距离',
            );
          }
          throw err;
        }
      }

      await client.query('COMMIT');
      return voyageToJson(v);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
