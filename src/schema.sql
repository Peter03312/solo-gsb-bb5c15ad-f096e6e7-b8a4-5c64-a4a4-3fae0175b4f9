-- 船舶危险货箱配载审定服务 初始化结构
-- 幂等：可重复执行

CREATE TABLE IF NOT EXISTS voyages (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_no            TEXT NOT NULL UNIQUE,
    n_bays               INTEGER NOT NULL CHECK (n_bays > 0),
    n_rows               INTEGER NOT NULL CHECK (n_rows > 0),
    n_tiers              INTEGER NOT NULL CHECK (n_tiers > 0),
    default_column_limit BIGINT NOT NULL CHECK (default_column_limit > 0), -- 毫克 (1kg = 1e6)
    rev                  INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 各列承重上限覆盖值（bay+row 维度的“列”）
CREATE TABLE IF NOT EXISTS column_weight_limits (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    bay          INTEGER NOT NULL CHECK (bay >= 1),
    row          INTEGER NOT NULL CHECK (row >= 1),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 毫克
    PRIMARY KEY (voyage_id, bay, row)
);

CREATE TABLE IF NOT EXISTS boxes (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    box_no     TEXT NOT NULL,
    weight_ug  BIGINT NOT NULL CHECK (weight_ug > 0), -- 毫克
    category   TEXT NOT NULL,
    PRIMARY KEY (voyage_id, box_no)
);

-- 不相容类别对 -> 正整数最小曼哈顿距离（未登记的类别对视为相容）
CREATE TABLE IF NOT EXISTS incompat_rules (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    cat_a        TEXT NOT NULL,
    cat_b        TEXT NOT NULL,
    min_distance INTEGER NOT NULL CHECK (min_distance > 0),
    PRIMARY KEY (voyage_id, cat_a, cat_b),
    CHECK (cat_a <= cat_b)
);

-- 配载布局按修订号全量留痕：每接受一批调整即产生一个新修订号，
-- 该修订号下的布局由 placements 中 (voyage_id, rev) 的所有行完整表示。
CREATE TABLE IF NOT EXISTS placements (
    voyage_id UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev       INTEGER NOT NULL CHECK (rev >= 0),
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL CHECK (bay >= 1),
    row       INTEGER NOT NULL CHECK (row >= 1),
    tier      INTEGER NOT NULL CHECK (tier >= 0),
    PRIMARY KEY (voyage_id, rev, box_no),
    UNIQUE (voyage_id, rev, bay, row, tier)
);
CREATE INDEX IF NOT EXISTS idx_placements_rev ON placements (voyage_id, rev);

-- 装载清单（签发后内容冻结到该修订号的布局；空布局亦可签发，但要求所有箱已配位）
CREATE TABLE IF NOT EXISTS manifests (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev        INTEGER NOT NULL CHECK (rev >= 0),
    issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    box_count  INTEGER NOT NULL CHECK (box_count >= 0),
    PRIMARY KEY (voyage_id, rev)
);

CREATE TABLE IF NOT EXISTS manifest_items (
    voyage_id UUID NOT NULL,
    rev       INTEGER NOT NULL,
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL,
    row       INTEGER NOT NULL,
    tier      INTEGER NOT NULL,
    PRIMARY KEY (voyage_id, rev, box_no),
    FOREIGN KEY (voyage_id, rev) REFERENCES manifests (voyage_id, rev) ON DELETE CASCADE
);

-- 现场装船核对作业：以航次某修订号的【已签发冻结清单】为核对基准开启，
-- 同一清单最多一个作业（voyage_id+manifest_rev 唯一）。
-- 基准引用冻结副本（manifest_items），后续布局调整/新清单不改变既有作业基准。
CREATE TABLE IF NOT EXISTS check_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_id    UUID NOT NULL,
    manifest_rev INTEGER NOT NULL CHECK (manifest_rev >= 0),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ,
    -- 作业内上报顺序号（同作业互斥递增；也用于“每箱最后一条上报”判定）
    next_seq     BIGINT NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
    UNIQUE (voyage_id, manifest_rev),
    FOREIGN KEY (voyage_id, manifest_rev)
        REFERENCES manifests (voyage_id, rev) ON DELETE CASCADE
);

-- 核对上报留痕：每次受理的上报均永久保存；(job_id, report_no) 唯一保证上报号幂等。
-- revoked=true（撤销）等价于“未装”，此时坐标必须为空；否则三维坐标必填。
CREATE TABLE IF NOT EXISTS check_reports (
    job_id      UUID NOT NULL REFERENCES check_jobs(id) ON DELETE CASCADE,
    report_no   TEXT NOT NULL,
    seq         BIGINT NOT NULL CHECK (seq > 0),
    box_no      TEXT NOT NULL,
    revoked     BOOLEAN NOT NULL,
    bay         INTEGER,
    row         INTEGER,
    tier        INTEGER,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, report_no),
    UNIQUE (job_id, seq),
    CHECK (revoked OR (bay IS NOT NULL AND row IS NOT NULL AND tier IS NOT NULL)),
    CHECK (NOT revoked OR (bay IS NULL AND row IS NULL AND tier IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_check_reports_box ON check_reports (job_id, box_no, seq);

-- ============================================================================
-- 安全约束按修订号留痕：
--   每个修订号（含登记时的 rev=0）对应一整套生效约束——默认列承重、
--   按 (bay,row) 覆盖的单列限额、不相容类别对最小距离。
-- 约束变更整组替换：未出现在新清单中的覆盖项/类别对视为撤销。
-- 每次接受“整批调整”或“约束变更”后，新修订号继承一套完整快照。
-- 上方的 voyages.default_column_limit / column_weight_limits / incompat_rules
-- 仅作为“当前修订号”的镜像保留，供既有接口字段兼容使用。
-- ============================================================================

-- 每个修订号生效的默认列承重上限（每航次每修订号一行）
CREATE TABLE IF NOT EXISTS voyage_rev_default_limits (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 微克
    PRIMARY KEY (voyage_id, rev)
);

-- 每个修订号生效的按列承重覆盖清单（整组替换语义的留痕副本）
CREATE TABLE IF NOT EXISTS voyage_rev_column_limits (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    bay          INTEGER NOT NULL CHECK (bay >= 1),
    row          INTEGER NOT NULL CHECK (row >= 1),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 微克
    PRIMARY KEY (voyage_id, rev, bay, row)
);

-- 每个修订号生效的不相容类别对清单（整组替换语义的留痕副本，cat_a <= cat_b）
CREATE TABLE IF NOT EXISTS voyage_rev_incompat_rules (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    cat_a        TEXT NOT NULL,
    cat_b        TEXT NOT NULL,
    min_distance INTEGER NOT NULL CHECK (min_distance > 0),
    PRIMARY KEY (voyage_id, rev, cat_a, cat_b),
    CHECK (cat_a <= cat_b)
);
