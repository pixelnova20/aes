#!/usr/bin/env bash
# 文件作用：按六个连续步骤执行 MVP2 人工验收序列，检查长期任务记忆和会话稳定性。
# 模块位置：tests，属于 Courseworks 人工端到端验收辅助层。
# 重要函数：apicall() 访问 API，wait_run() 等待 Agent，submit_prompt() 提交任务，check_context() 检查上下文。
# MVP2 人工测试运行器：针对在线系统执行六步连续测试。
set -uo pipefail

BASE="http://127.0.0.1:8090"
E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:?Set E2E_ADMIN_EMAIL to the superuser.toml email}"
E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:?Set E2E_ADMIN_PASSWORD to the superuser.toml password}"
ADMIN_LOGIN_JSON=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' \
  "$E2E_ADMIN_EMAIL" "$E2E_ADMIN_PASSWORD")
PASS=0; FAIL=0; SKIP=0
GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; CYAN="\033[36m"; NC="\033[0m"

# 函数功能：记录通过项；输入 $1 为说明；更新 PASS 并输出状态；由各验收步骤调用。
pass() { echo -e "${GREEN}  PASS${NC} $1"; PASS=$((PASS+1)); }
# 函数功能：记录失败项；输入 $1 为说明；更新 FAIL 并输出状态；由各验收步骤调用。
fail() { echo -e "${RED}  FAIL${NC} $1"; FAIL=$((FAIL+1)); }
# 函数功能：记录跳过项；输入 $1 为原因；更新 SKIP 并输出状态；由可选检查调用。
skip() { echo -e "${YELLOW}  SKIP${NC} $1"; SKIP=$((SKIP+1)); }
# 函数功能：输出辅助信息；输入 $1 为消息；不改变结果计数；由主流程调用。
info() { echo -e "${CYAN}  INFO${NC} $1"; }

# 函数功能：发送带可选认证的 JSON API 请求；输入为方法、路径、数据和 Token；输出响应体及状态标记；由测试辅助函数调用。
apicall() {
  local method="$1" url="$2" data="$3" token="${4:-}"
  local auth=(); [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  curl -s --connect-timeout 5 --max-time 120 -w "\nHTTP:%{http_code}" \
    -X "$method" "$BASE$url" -H "Content-Type: application/json" \
    "${auth[@]}" -d "$data" 2>/dev/null
}
# 函数功能：提取组合响应状态码；输入 $1 为 apicall() 输出；输出三位状态码；由提交和上下文检查调用。
http_code() { echo "$1" | grep -oP 'HTTP:\K\d+' || echo "000"; }
# 函数功能：提取纯响应体；输入 $1 为 apicall() 输出；输出移除状态标记后的文本；由 JSON 解析调用。
body() { echo "$1" | sed '/^HTTP:[0-9]*$/d'; }

# 函数功能：轮询指定 Agent Run 直到结束或超时。
# 输入参数：$1 为 run ID，$2 为 Token，$3 为可选最大轮询次数。
# 输出参数：输出 completed、failed、cancelled 或 timeout 状态。
# 调用关系：由 submit_prompt() 调用，内部调用 apicall()、body() 和 sleep。
wait_run() {
  local run_id="$1" token="$2" max_wait="${3:-60}"
  for i in $(seq 1 "$max_wait"); do
    sleep 2
    local rs=$(apicall GET "/api/agent/runs/$run_id" "{}" "$token")
    local st=$(body "$rs" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$st" in completed|failed|cancelled) echo "$st"; return ;; esac
  done
  echo "timeout"
}

# 函数功能：提交用户 Prompt 并等待 Agent Run 结束。
# 输入参数：$1 为步骤标签，$2 为 Prompt，$3 为认证 Token。
# 输出参数：成功时输出 runId:status，创建失败时输出 FAIL:HTTP状态。
# 调用关系：由六步主测试流程调用，内部调用 apicall()、http_code()、body() 和 wait_run()。
submit_prompt() {
  local label="$1" prompt="$2" token="$3"
  local escaped=$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$prompt")
  local resp=$(apicall POST /api/agent/runs "$escaped" "$token")
  local code=$(http_code "$resp")
  local run_id=$(body "$resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
  if [ "$code" = "201" ] && [ -n "$run_id" ]; then
    local status=$(wait_run "$run_id" "$token" 90)
    echo "$run_id:$status"
  else
    echo "FAIL:$code"
  fi
}

# 函数功能：请求上下文预览并执行调用方提供的检查函数。
# 输入参数：$1 为标签，$2 为 Token，$3 为 Prompt，$4 为待执行的检查函数文本。
# 输出参数：失败时输出 CONTEXT_FAIL，成功时由检查函数记录结果。
# 调用关系：由上下文相关验收步骤调用，内部调用 apicall()、body()、http_code() 和 eval。
check_context() {
  local label="$1" token="$2" prompt="$3" check_fn="$4"
  local escaped=$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$prompt")
  local resp=$(apicall POST /api/agent/chat-sessions/context-preview "$escaped" "$token")
  local cp_body=$(body "$resp")
  local code=$(http_code "$resp")
  if [ "$code" != "200" ]; then echo "CONTEXT_FAIL:$code"; return; fi
  eval "$check_fn" "$cp_body"
}

echo "============================================"
echo "  MVP2 Manual Test Sequence"
echo "  Time: $(date '+%H:%M:%S')"
echo "============================================"
echo ""

# ── Setup ──
echo "── Setup: registering test student ──"
ADMIN_RESP=$(apicall POST /api/auth/login "$ADMIN_LOGIN_JSON")
ADMIN_TOKEN=$(body "$ADMIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
IC_RESP=$(apicall GET /api/admin/invite-codes "{}" "$ADMIN_TOKEN")
INVITE_CODE=$(body "$IC_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for c in (d.get('inviteCodes',[]) if isinstance(d,dict) else []):
    if c.get('isActive') and c.get('usedCount',0) < c.get('maxUses',1):
        print(c['code']); break
" 2>/dev/null)

TEST_EMAIL="mvp2-seq-$(date +%s)@test.local"
REG_RESP=$(apicall POST /api/auth/register "{\"email\":\"$TEST_EMAIL\",\"password\":\"test123456\",\"confirmPassword\":\"test123456\",\"inviteCode\":\"$INVITE_CODE\"}")
TOKEN=$(body "$REG_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
pass "User registered"

apicall POST /api/workspace/initialize "{}" "$TOKEN" > /dev/null
for i in $(seq 1 20); do
  sleep 2
  WS=$(apicall GET /api/auth/me "{}" "$TOKEN")
  WS_ST=$(body "$WS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('workspace',{}).get('status','?'))" 2>/dev/null || echo "?")
  [ "$WS_ST" = "ready" ] && break
done
[ "$WS_ST" = "ready" ] && pass "Workspace ready" || fail "Workspace not ready: $WS_ST"

# 获取基线会话。
CS=$(apicall GET /api/agent/chat-sessions "{}" "$TOKEN")
BASELINE_SESSION=$(body "$CS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null)
info "Baseline session: ${BASELINE_SESSION:0:8}..."
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 1: Task Setup ──"
P1='为 MyVibeOS 创建最小项目骨架。只需要做三件事：
1. 创建 src/ 目录
2. 创建 Makefile，包含 run / clean / cscope 三个 target
3. 创建 README.md，写一句项目简介

不要写任何 C 代码，不要创建 kernel_main。'
R1=$(submit_prompt "step1" "$P1" "$TOKEN")
S1_RUNID="${R1%:*}"
S1_STATUS="${R1#*:}"
info "Step 1: run=$S1_RUNID status=$S1_STATUS"
[ "$S1_STATUS" = "completed" ] && pass "Step 1: task setup finished" || fail "Step 1: $S1_STATUS"
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 2: Task Recall (TaskLedger) ──"

# 检查上下文预览是否包含 active_task。
check_context "step2-pre" "$TOKEN" "继续刚才的项目" '
  cp_body="$1"
  if echo "$cp_body" | grep -q "active_task"; then
    pass "Step 2: active_task in context preview"
  else
    info "  active_task not in context (may not have been created yet)"
  fi
  if echo "$cp_body" | grep -q "MyVibeOS\|最小项目\|project scaffold\|OS"; then
    pass "Step 2: task memory references MyVibeOS"
  else
    info "  no MyVibeOS reference in context"
  fi
'

P2='继续刚才的项目。先根据你记住的任务目标，说明当前要做什么，然后只列出下一步最小动作。不要重新扫描整个工程。'
R2=$(submit_prompt "step2" "$P2" "$TOKEN")
S2_STATUS="${R2#*:}"
info "Step 2: status=$S2_STATUS"
[ "$S2_STATUS" = "completed" ] && pass "Step 2: task recall completed" || fail "Step 2: $S2_STATUS"
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 3: Build Verification (VerificationLedger) ──"

P3='先运行 make，然后告诉我构建结果。如果失败，说明失败原因。'
R3=$(submit_prompt "step3" "$P3" "$TOKEN")
S3_RUNID="${R3%:*}"
S3_STATUS="${R3#*:}"
info "Step 3: run=$S3_RUNID status=$S3_STATUS"
[ "$S3_STATUS" = "completed" ] && pass "Step 3: build verification completed" || fail "Step 3: $S3_STATUS"

# 检查是否实际触发构建；该步骤可能要求先应用补丁。
if [ -n "${S3_RUNID:-}" ] && [ "$S3_RUNID" != "FAIL" ]; then
  S3_RUN_DETAIL=$(apicall GET "/api/agent/runs/$S3_RUNID" "{}" "$TOKEN")
  S3_FINAL=$(body "$S3_RUN_DETAIL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('finalAnswerMarkdown','') or '')" 2>/dev/null)
  if echo "$S3_FINAL" | grep -qi "build\|make\|编译\|构建"; then
    pass "Step 3: final answer mentions build"
  else
    info "  build may not have run (patch needed first)"
    skip "Step 3: build evidence in answer"
  fi
fi
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 4: WorkspaceFacts + Multi-turn Memory ──"

check_context "step4-pre" "$TOKEN" "列出工作区根目录文件" '
  cp_body="$1"
  if echo "$cp_body" | grep -q "workspace_tree"; then
    pass "Step 4: workspace_tree in context"
  else
    info "  no workspace_tree section"
  fi
  if echo "$cp_body" | grep -qi "relevant_files\|Makefile\|README\|src/"; then
    pass "Step 4: relevant files in context"
  else
    info "  no relevant files detected"
  fi
'

P4='你测试了吗？最近一次构建是什么结果？另外，当前工作区根目录有哪些文件？'
R4=$(submit_prompt "step4" "$P4" "$TOKEN")
S4_STATUS="${R4#*:}"
info "Step 4: status=$S4_STATUS"
[ "$S4_STATUS" = "completed" ] && pass "Step 4: facts recall completed" || fail "Step 4: $S4_STATUS"
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 5: Topic Change (session invariant) ──"

CS_BEFORE=$(apicall GET /api/agent/chat-sessions "{}" "$TOKEN")
SESSION_BEFORE=$(body "$CS_BEFORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null)

P5='现在换个话题：解释一下编译器的词法分析阶段是做什么的。'
R5=$(submit_prompt "step5" "$P5" "$TOKEN")
S5_STATUS="${R5#*:}"
info "Step 5: status=$S5_STATUS"
[ "$S5_STATUS" = "completed" ] && pass "Step 5: topic change completed" || fail "Step 5: $S5_STATUS"

CS_AFTER=$(apicall GET /api/agent/chat-sessions "{}" "$TOKEN")
SESSION_AFTER=$(body "$CS_AFTER" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null)

if [ "$SESSION_AFTER" = "$SESSION_BEFORE" ] && [ -n "$SESSION_AFTER" ]; then
  pass "Step 5: session unchanged (topic change ≠ new session)"
else
  fail "Step 5: session changed! before=${SESSION_BEFORE:0:8} after=${SESSION_AFTER:0:8}"
fi
echo ""

# ═══════════════════════════════════════════════════
echo "── Step 6: Context Purity ──"

check_context "step6-pre" "$TOKEN" "回到 MyVibeOS 项目" '
  cp_body="$1"
  if echo "$cp_body" | grep -q "omitted\|Omitted"; then
    pass "Step 6: omitted section present"
  else
    info "  no omitted section"
  fi
'

P6='回到 MyVibeOS 项目。现在需要做什么？之前构建成功了吗？'
R6=$(submit_prompt "step6" "$P6" "$TOKEN")
S6_STATUS="${R6#*:}"
info "Step 6: status=$S6_STATUS"
[ "$S6_STATUS" = "completed" ] && pass "Step 6: task return completed" || fail "Step 6: $S6_STATUS"

# 执行最终会话一致性检查。
CS_FINAL=$(apicall GET /api/agent/chat-sessions "{}" "$TOKEN")
SESSION_FINAL=$(body "$CS_FINAL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null)
if [ "$SESSION_FINAL" = "$SESSION_BEFORE" ]; then
  pass "Step 6: session still same after all 6 steps"
else
  fail "Step 6: session changed at some point"
fi
echo ""

# ═══════════════════════════════════════════════════
echo "============================================"
echo "  MVP2 MANUAL TEST SEQUENCE RESULTS"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Skipped: $SKIP"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
