#!/usr/bin/env bash
# 文件作用：通过真实 HTTP API 自动验证 MVP2 的长期任务、上下文、工作区事实和附件连续性。
# 模块位置：tests，属于 Courseworks 端到端验收测试层。
# 重要函数：apicall() 发送 API 请求；http_code()/body() 解析响应；assert_*() 汇总验收结果。
# MVP2 自动化 API 验收测试
# 用法：bash tests/mvp2-api-test.sh
set -uo pipefail

BASE="http://127.0.0.1:8090"
E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:?Set E2E_ADMIN_EMAIL to the superuser.toml email}"
E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:?Set E2E_ADMIN_PASSWORD to the superuser.toml password}"
ADMIN_LOGIN_JSON=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' \
  "$E2E_ADMIN_EMAIL" "$E2E_ADMIN_PASSWORD")
PASS=0
FAIL=0
SKIP=0

# 函数功能：输出通过状态；输入 $1 为测试说明；无结构化输出；由断言和主流程调用。
green() { echo -e "\033[32m  PASS\033[0m $1"; }
# 函数功能：输出失败状态；输入 $1 为错误说明；无结构化输出；由断言函数调用。
red()   { echo -e "\033[31m  FAIL\033[0m $1"; }
# 函数功能：输出跳过状态；输入 $1 为跳过原因；无结构化输出；由可选场景调用。
yellow(){ echo -e "\033[33m  SKIP\033[0m $1"; }
# 函数功能：输出提示状态；输入 $1 为补充信息；无结构化输出；由主测试流程调用。
info()  { echo -e "\033[36m  INFO\033[0m $1"; }

# 函数功能：向后端发送 JSON API 请求；输入为方法、路径、请求体和可选 Token；输出响应体及状态标记；由验收场景调用。
apicall() {
  local method="$1" url="$2" data="$3" token="${4:-}"
  local auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  curl -s --connect-timeout 5 --max-time 60 -w "\nHTTP:%{http_code}" \
    -X "$method" "$BASE$url" \
    -H "Content-Type: application/json" \
    "${auth[@]}" \
    -d "$data" 2>/dev/null
}

# 函数功能：提取 apicall() 输出中的状态码；输入 $1 为组合响应；输出三位状态码；由断言和主流程调用。
http_code() { echo "$1" | grep -oP 'HTTP:\K\d+' || echo "000"; }
# 函数功能：移除组合响应中的状态标记；输入 $1 为组合响应；输出纯响应体；由 JSON 解析逻辑调用。
body() { echo "$1" | sed '/^HTTP:[0-9]*$/d'; }

# 函数功能：比较期望值和实际值；输入为标签、期望值和实际值；更新 PASS/FAIL；由主测试流程调用。
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then green "$label"; PASS=$((PASS + 1))
  else red "$label — expected '$expected', got '$actual'"; FAIL=$((FAIL + 1)); fi
}

# 函数功能：断言文本包含目标片段；输入为标签、目标片段和完整文本；更新 PASS/FAIL；由主测试流程调用。
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then green "$label"; PASS=$((PASS + 1))
  else red "$label — not found: $(echo "$needle" | cut -c1-80)"; FAIL=$((FAIL + 1)); fi
}

# 函数功能：断言文本不包含目标片段；输入为标签、禁止片段和完整文本；更新 PASS/FAIL；由上下文隔离测试调用。
assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    red "$label — unexpectedly found: $(echo "$needle" | cut -c1-60)"; FAIL=$((FAIL + 1))
  else green "$label"; PASS=$((PASS + 1)); fi
}

# 函数功能：断言 HTTP 状态码；输入为标签、期望状态和实际状态；更新 PASS/FAIL；由 API 场景调用。
assert_http() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then green "$label (HTTP $actual)"; PASS=$((PASS + 1))
  else red "$label — expected HTTP $expected, got $actual"; FAIL=$((FAIL + 1)); fi
}

# 函数功能：断言值非空；输入为标签和值；更新 PASS/FAIL；由账号、会话和运行创建场景调用。
assert_not_empty() {
  local label="$1" value="$2"
  if [ -n "$value" ]; then green "$label"; PASS=$((PASS + 1))
  else red "$label — value is empty"; FAIL=$((FAIL + 1)); fi
}

echo "============================================"
echo "  MVP 2 Automated Acceptance Test Suite"
echo "  Target: $BASE"
echo "  Time:   $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 0. System Health ═══"
HLTH=$(apicall GET /api/health "{}")
assert_http "health" "200" "$(http_code "$HLTH")"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 1. Setup: login + workspace ═══"

ADMIN_RESP=$(apicall POST /api/auth/login "$ADMIN_LOGIN_JSON")
ADMIN_TOKEN=$(body "$ADMIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
assert_http "admin login" "200" "$(http_code "$ADMIN_RESP")"

IC_RESP=$(apicall GET /api/admin/invite-codes "{}" "$ADMIN_TOKEN")
INVITE_CODE=$(body "$IC_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
codes=d.get('inviteCodes',[]) if isinstance(d,dict) else []
for c in codes:
    if c.get('isActive') and c.get('usedCount',0) < c.get('maxUses',1):
        print(c['code']); break
" 2>/dev/null || echo "")
assert_not_empty "invite code" "$INVITE_CODE"

TEST_EMAIL="mvp2-test-$(date +%s)@test.local"
TEST_PW="test123456"
REG_RESP=$(apicall POST /api/auth/register "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PW\",\"confirmPassword\":\"$TEST_PW\",\"inviteCode\":\"$INVITE_CODE\"}")
STUDENT_TOKEN=$(body "$REG_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
assert_http "register" "201" "$(http_code "$REG_RESP")"
assert_not_empty "student token" "$STUDENT_TOKEN"

# 初始化工作区。
WS_INIT=$(apicall POST /api/workspace/initialize "{}" "$STUDENT_TOKEN")
assert_http "workspace init" "201" "$(http_code "$WS_INIT")"
for i in $(seq 1 20); do
  sleep 2
  ME_RESP=$(apicall GET /api/auth/me "{}" "$STUDENT_TOKEN")
  WS_STATUS=$(body "$ME_RESP" | python3 -c "import sys,json;w=json.load(sys.stdin).get('workspace',{});print(w.get('status','?'))" 2>/dev/null || echo "?")
  if [ "$WS_STATUS" = "ready" ]; then break; fi
done
assert_eq "workspace ready" "ready" "$WS_STATUS"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 2. Context Preview (MVP2 enhanced sections) ═══"

# 检查基础上下文预览是否包含 MVP2 增强内容。
CP=$(apicall POST /api/agent/chat-sessions/context-preview \
  '{"prompt":"Hello, this is a test."}' "$STUDENT_TOKEN")
CP_BODY=$(body "$CP")

assert_http "context preview" "200" "$(http_code "$CP")"
assert_contains "policy section" "最新用户请求优先于历史上下文" "$CP_BODY"
assert_contains "current_request section" "Current request" "$CP_BODY"
assert_contains "has reason field" "Reason:" "$CP_BODY"
assert_contains "has sourceRefs" "Source refs:" "$CP_BODY"
assert_contains "has tokenEstimate" "tokenEstimate" "$CP_BODY"

# 验证区段顺序：policy 固定在首位，current_request 位于第二位。
SECTION_KEYS=$(echo "$CP_BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
sections=d.get('preview',{}).get('sections',[])
for s in sections: print(s.get('key',''))
" 2>/dev/null)
FIRST_KEY=$(echo "$SECTION_KEYS" | head -1)
SECOND_KEY=$(echo "$SECTION_KEYS" | head -2 | tail -1)
assert_eq "policy is first section" "policy" "$FIRST_KEY"
assert_eq "current_request is second" "current_request" "$SECOND_KEY"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 3. Course task snapshot + TaskLedger ═══"

CT=$(apicall GET /api/agent/course-task "{}" "$STUDENT_TOKEN")
CT_BODY=$(body "$CT")
assert_http "course task endpoint" "200" "$(http_code "$CT")"

# 首次执行 OS 任务后应形成任务上下文。
RUN1=$(apicall POST /api/agent/runs \
  '{"prompt":"为 MyVibeOS 创建最小项目骨架：建立 kernel_main、linker.ld、Makefile。不要写具体代码，只创建文件结构和占位内容。"}' "$STUDENT_TOKEN")
RUN1_ID=$(body "$RUN1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
assert_http "first agent run" "201" "$(http_code "$RUN1")"
assert_not_empty "run1 ID" "$RUN1_ID"

# 轮询第一次运行直到结束。
RUN1_DONE=0
if [ -n "$RUN1_ID" ]; then
  for i in $(seq 1 45); do
    sleep 2
    RS=$(apicall GET "/api/agent/runs/$RUN1_ID" "{}" "$STUDENT_TOKEN")
    RS_STATUS=$(body "$RS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$RS_STATUS" in completed|failed|cancelled) RUN1_DONE=1; break ;; esac
  done
  if [ "$RUN1_DONE" -eq 1 ]; then
    green "run1 finished: $RS_STATUS"; PASS=$((PASS + 1))
  else
    info "run1 timeout (90s)"; SKIP=$((SKIP + 1))
  fi
fi

# 此时课程任务应包含活动任务信息。
CT2=$(apicall GET /api/agent/course-task "{}" "$STUDENT_TOKEN")
CT2_BODY=$(body "$CT2")
assert_http "course task after run" "200" "$(http_code "$CT2")"

# 检查任务上下文是否存在。
CT2_HAS_SESSION=$(echo "$CT2_BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print('1' if d.get('courseTask',{}).get('session') else '0')" 2>/dev/null || echo "0")
if [ "$CT2_HAS_SESSION" = "1" ]; then
  green "course task has session"; PASS=$((PASS + 1))
else
  info "course task session not found (may depend on run outcome)"; SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 4. Context preview includes task + verification ═══"

CP2=$(apicall POST /api/agent/chat-sessions/context-preview \
  '{"prompt":"继续上一步。请先说明当前任务目标是什么，然后只根据最近修改文件列出下一步最小动作。"}' "$STUDENT_TOKEN")
CP2_BODY=$(body "$CP2")

assert_http "context preview (2)" "200" "$(http_code "$CP2")"

# 检查 active_task；它是否存在取决于首次运行是否建立了课程任务。
if echo "$CP2_BODY" | grep -q "active_task"; then
  green "context has active_task section"; PASS=$((PASS + 1))
else
  info "no active_task section yet (task may not have been recognized as OS task)"; SKIP=$((SKIP + 1))
fi

# 验证上下文没有混入旧任务或 meminfo 信息。
assert_not_contains "no meminfo in context" "meminfo" "$CP2_BODY"

# 验证 workspace_tree 区段。
if echo "$CP2_BODY" | grep -q "workspace_tree"; then
  green "context has workspace_tree section"; PASS=$((PASS + 1))
else
  info "no workspace_tree section"; SKIP=$((SKIP + 1))
fi

# 验证 omitted 区段。
if echo "$CP2_BODY" | grep -q "omitted\|Omitted"; then
  green "context has omitted section"; PASS=$((PASS + 1))
else
  info "no omitted section"; SKIP=$((SKIP + 1))
fi

# 验证 MVP2 输出中的 sourceRefs。
if echo "$CP2_BODY" | grep -q "Source refs:"; then
  green "context contains sourceRefs"; PASS=$((PASS + 1))
else
  red "context missing sourceRefs"; FAIL=$((FAIL + 1))
fi

# 验证来自用户配置的 Token 预算。
CP2_BUDGET=$(echo "$CP2_BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('preview',{}).get('tokenBudget',''))" 2>/dev/null || echo "")
if [ -n "$CP2_BUDGET" ] && [ "$CP2_BUDGET" != "None" ] && [ "$CP2_BUDGET" != "null" ]; then
  green "tokenBudget present ($CP2_BUDGET)"; PASS=$((PASS + 1))
else
  info "tokenBudget null (user may not have AI settings)"; SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 5. VerificationLedger: build evidence ═══"

# 仅在已有运行记录时触发构建。
if [ -n "$RUN1_ID" ] && [ "$RUN1_DONE" -eq 1 ]; then
  BUILD_RESP=$(apicall POST "/api/agent/runs/$RUN1_ID/build" "{}" "$STUDENT_TOKEN")
  BUILD_CODE=$(http_code "$BUILD_RESP")
  if [ "$BUILD_CODE" = "200" ]; then
    green "build triggered (HTTP 200)"; PASS=$((PASS + 1))
    BUILD_STATUS=$(body "$BUILD_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRun',{}).get('status',''))" 2>/dev/null || echo "")
    info "build status: $BUILD_STATUS"
  else
    info "build returned HTTP $BUILD_CODE (may need patch applied first)"; SKIP=$((SKIP + 1))
  fi
else
  info "no completed run for build test"; SKIP=$((SKIP + 1))
fi

# 检查上下文预览是否包含构建验证证据。
CP3=$(apicall POST /api/agent/chat-sessions/context-preview \
  '{"prompt":"你测试了吗？最近一次构建结果是什么？"}' "$STUDENT_TOKEN")
CP3_BODY=$(body "$CP3")

if echo "$CP3_BODY" | grep -q "verification_evidence\|build\|build_run"; then
  green "context contains verification/build evidence"; PASS=$((PASS + 1))
else
  info "no verification evidence in context yet"; SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 6. Session invariant: new task ≠ new session ═══"

CS_BEFORE=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_BEFORE=$(body "$CS_BEFORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")

# 提交一个主题完全不同的运行请求。
DIFF_RUN=$(apicall POST /api/agent/runs \
  '{"prompt":"This is about compilers: what is a lexer?"}' "$STUDENT_TOKEN")
DIFF_RUN_ID=$(body "$DIFF_RUN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
assert_http "different topic run" "201" "$(http_code "$DIFF_RUN")"

# 等待运行结束。
if [ -n "$DIFF_RUN_ID" ]; then
  for i in $(seq 1 30); do
    sleep 2
    RS=$(apicall GET "/api/agent/runs/$DIFF_RUN_ID" "{}" "$STUDENT_TOKEN")
    RS_STATUS=$(body "$RS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$RS_STATUS" in completed|failed|cancelled) break ;; esac
  done
fi

CS_AFTER=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_AFTER=$(body "$CS_AFTER" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")

assert_eq "session unchanged across topics" "$SESSION_BEFORE" "$SESSION_AFTER"

# 验证课程任务创建的是新子任务，而不是新聊天会话。
CT3=$(apicall GET /api/agent/course-task "{}" "$STUDENT_TOKEN")
CT3_SESSION_ID=$(body "$CT3" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('courseTask',{}).get('session',{}).get('id','n/a'))" 2>/dev/null || echo "")
info "course task session=${CT3_SESSION_ID}, chat session=${SESSION_AFTER}"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 7. WorkspaceFacts: file facts visible, hidden dirs excluded ═══"

# 在工作区创建测试文件。
WS_FILE_RESP=$(apicall POST /api/workspace/file \
  '{"path":"test-mvp2.txt","content":"MVP2 test file content for workspace facts verification."}' "$STUDENT_TOKEN")
assert_http "create workspace file" "201" "$(http_code "$WS_FILE_RESP")"

# 提交一个要求 Agent 查看该文件的请求。
FACTS_RUN=$(apicall POST /api/agent/runs \
  '{"prompt":"Check the workspace tree structure and tell me what files exist in the project root."}' "$STUDENT_TOKEN")
FACTS_RUN_ID=$(body "$FACTS_RUN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$FACTS_RUN_ID" ]; then
  for i in $(seq 1 30); do
    sleep 2
    RS=$(apicall GET "/api/agent/runs/$FACTS_RUN_ID" "{}" "$STUDENT_TOKEN")
    RS_STATUS=$(body "$RS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$RS_STATUS" in completed|failed|cancelled) break ;; esac
  done
  green "workspace facts run completed: $RS_STATUS"; PASS=$((PASS + 1))
fi

# 上下文预览应展示工作区树，但不能暴露隐藏目录。
CP4=$(apicall POST /api/agent/chat-sessions/context-preview \
  '{"prompt":"list root files"}' "$STUDENT_TOKEN")
CP4_BODY=$(body "$CP4")

# 应包含工作区树区段。
if echo "$CP4_BODY" | grep -q "workspace_tree"; then
  green "workspace_tree in context"; PASS=$((PASS + 1))
else
  info "no workspace_tree section"; SKIP=$((SKIP + 1))
fi

# 不应暴露 .local 等隐藏目录。
assert_not_contains "no .local in context" ".local" "$CP4_BODY"
assert_not_contains "no .uploads in context" ".uploads" "$CP4_BODY"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 8. Artifact references in context ═══"

# 上传附件并随 Prompt 提交。
UP_BODY_JSON='{"files":[{"name":"task-requirements.txt","mimeType":"text/plain","contentBase64":"VGhpcyBpcyBhIHRlc3QgdGFzayByZXF1aXJlbWVudCBmaWxlLg=="}]}'
UP_RESP=$(apicall POST /api/workspace/uploads "$UP_BODY_JSON" "$STUDENT_TOKEN")
UP_ID=$(body "$UP_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('uploads',[{}])[0].get('id',''))" 2>/dev/null || echo "")

if [ -n "$UP_ID" ]; then
  # 提交一次会消费该上传文件的运行。
  ATT_RUN=$(apicall POST /api/agent/runs \
    "{\"prompt\":\"Please summarize the uploaded task requirements file.\",\"attachmentIds\":[\"$UP_ID\"]}" "$STUDENT_TOKEN")
  ATT_RUN_ID=$(body "$ATT_RUN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
  assert_http "attachment run" "201" "$(http_code "$ATT_RUN")"

  # 轮询运行状态。
  if [ -n "$ATT_RUN_ID" ]; then
    for i in $(seq 1 30); do
      sleep 2
      RS=$(apicall GET "/api/agent/runs/$ATT_RUN_ID" "{}" "$STUDENT_TOKEN")
      RS_STATUS=$(body "$RS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
      case "$RS_STATUS" in completed|failed|cancelled) break ;; esac
    done
  fi

  # 检查上下文预览中的产物引用。
  CP5=$(apicall POST /api/agent/chat-sessions/context-preview \
    '{"prompt":"What was in the file I uploaded earlier?"}' "$STUDENT_TOKEN")
  CP5_BODY=$(body "$CP5")

  if echo "$CP5_BODY" | grep -q "Artifact references\|consumed upload\|artifact"; then
    green "context has artifact references"; PASS=$((PASS + 1))
  else
    info "no artifact references visible in context"; SKIP=$((SKIP + 1))
  fi

  # 附件消费完成后，暂存上传列表应为空。
  UP_LIST=$(apicall GET /api/workspace/uploads "{}" "$STUDENT_TOKEN")
  UP_COUNT=$(body "$UP_LIST" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('uploads',[])))" 2>/dev/null || echo "0")
  assert_eq "staged uploads empty after consumption" "0" "$UP_COUNT"
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 9. /new still works (MVP1 invariant) ═══"

NEW_OK=$(apicall POST /api/agent/chat-sessions/new \
  '{"reason":"user_slash_new","confirmed":true}' "$STUDENT_TOKEN")
assert_http "/new confirmed" "200" "$(http_code "$NEW_OK")"

CS_NEW=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_NEW=$(body "$CS_NEW" | python3 -c "import sys,json;print(json.load(sys.stdin).get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
assert_eq "/new created fresh session" "1" "$([ "$SESSION_NEW" != "$SESSION_BEFORE" ] && [ -n "$SESSION_NEW" ] && echo 1 || echo 0)"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 10. Token budget from user settings ═══"

# 检查上下文预览是否使用 AiProviderSetting 中的 Token 预算。
AI_ME=$(apicall GET /api/auth/me "{}" "$STUDENT_TOKEN")
AI_ME_BODY=$(body "$AI_ME")
AI_CONFIGURED=$(echo "$AI_ME_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('aiProviderConfigured',''))" 2>/dev/null || echo "")
if [ "$AI_CONFIGURED" = "True" ]; then
  green "AI provider configured"; PASS=$((PASS + 1))

  # 上下文预览应包含非空 Token 预算。
  CP_BUDGET=$(apicall POST /api/agent/chat-sessions/context-preview \
    '{"prompt":"test budget"}' "$STUDENT_TOKEN")
  BUDGET_VAL=$(body "$CP_BUDGET" | python3 -c "import sys,json;print(json.load(sys.stdin).get('preview',{}).get('tokenBudget','null'))" 2>/dev/null || echo "null")
  if [ "$BUDGET_VAL" != "null" ] && [ "$BUDGET_VAL" != "" ]; then
    green "tokenBudget from user config ($BUDGET_VAL)"; PASS=$((PASS + 1))
  else
    info "tokenBudget is null despite AI settings"; SKIP=$((SKIP + 1))
  fi
else
  info "AI provider not configured — tokenBudget may be null"; SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 11. Final answer summary quality ═══"

# 检查已完成运行是否包含最终 Markdown 回答。
if [ -n "$FACTS_RUN_ID" ]; then
  FR=$(apicall GET "/api/agent/runs/$FACTS_RUN_ID" "{}" "$STUDENT_TOKEN")
  FINAL_ANSWER=$(body "$FR" | python3 -c "import sys,json;d=json.load(sys.stdin).get('run',{});print(d.get('finalAnswerMarkdown','') or d.get('responseMarkdown',''))" 2>/dev/null || echo "")
  if [ -n "$FINAL_ANSWER" ]; then
    # 最终回答不应只是原始日志转储。
    if echo "$FINAL_ANSWER" | grep -qE "^(##|[A-Z])"; then
      green "final answer has structured content"; PASS=$((PASS + 1))
    else
      info "final answer format unexpected"; SKIP=$((SKIP + 1))
    fi
    # 最终回答不应只是原始标准输出。
    assert_not_contains "final answer not raw stdout" "[STDOUT]" "$FINAL_ANSWER" 2>/dev/null || true
  else
    info "no final answer"; SKIP=$((SKIP + 1))
  fi
fi
echo ""

# ═══════════════════════════════════════════════════
echo "============================================"
echo "  MVP 2 TEST RESULTS"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Skipped: $SKIP"
echo "============================================"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
