#!/usr/bin/env bash
# 航次安全约束变更 —— curl 调用示例
#
# 用法:
#   BASE=http://localhost:3000 bash examples/constraints-curl.sh
#
# 演示本轮语义：
#   登记/配位 -> 收紧约束被当前布局复验拒绝(422, 箱号/位置/原因, 规则与修订号不变)
#   -> 过期修订号(409 回带当前号) -> 整组替换受理(未列出的覆盖项/类别对即撤销)
#   -> 修订号+1、布局原样继承 -> 历史修订号仍展示当时生效的约束
#   -> 后续调整使用新约束 -> 已签发清单/在办核对仍以各自冻结副本为基准。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-2026-CON（默认承重 10000；列(1,1) 覆盖 1200；类别对 1|3 距离 3）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-2026-CON",
  "bays": 3, "rows": 2, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "600", "category": "3" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

say "2) 放一个在旧约束下合法的布局（两箱曼哈顿距离 3，达标）-> revision=1"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } }
  ]
}'; echo

say "3) 收紧类别对距离到 4：当前布局复验不通过 -> 422（箱号/位置/原因；规则与修订号不变）"
curl -sS -X PUT "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 4 }
  ]
}'; echo

say "4) 过期修订号 -> 409，details.currentRevision 回带当前修订号"
curl -sS -X PUT "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 42,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo

say "5) 请求级校验（沿用登记规则）：列坐标越界 / 列覆盖重复 / 类别对重复 -> 400"
curl -sS -X PUT "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 9, "row": 1, "weightLimit": "1200" }
  ],
  "incompatRules": []
}'; echo

say "6) 受理整组替换：默认承重改为 8000；撤销列(1,1)覆盖（不传即撤销）；撤销全部类别对（不传即相容）-> revision=2，布局原样继承"
curl -sS -X PUT "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "8000",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo

say "7) 历史布局 ?rev=1 仍展示当时生效的约束（10000 / 覆盖1200 / 距离3）"
curl -sS "$API/voyages/$VID/layout?rev=1"; echo

say "8) 只看约束（当前 rev=2）"
curl -sS "$API/voyages/$VID/constraints"; echo

say "9) 历史约束 ?rev=1（current=false）"
curl -sS "$API/voyages/$VID/constraints?rev=1"; echo

say "10) 类别对已撤销（相容）：后续调整可把两箱紧邻放置 -> revision=3，使用新约束"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 2,
  "moves": [
    { "boxNo": "BOX-2", "position": { "bay": 1, "row": 2, "tier": 0 } }
  ]
}'; echo

say "11) 此时想恢复严格类别对(距离3)：当前两箱相邻复验不通过 -> 422，必须先按新约束调整布局"
curl -sS -X PUT "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 3,
  "defaultColumnWeightLimit": "8000",
  "columnWeightLimits": [],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}'; echo

say "完成"
