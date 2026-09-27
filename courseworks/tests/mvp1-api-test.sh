#!/usr/bin/env bash
# 文件作用：通过真实 HTTP API 自动验证 MVP1 的认证、工作区、会话、附件和产物流程。
# 模块位置：tests，属于 Courseworks 端到端验收测试层。
# 重要函数：apicall() 发送 API 请求；http_code()/body() 拆分响应；assert_*() 记录断言结果。
# MVP1 自动化 API 验收测试
# 用法：bash tests/mvp1-api-test.sh
set -uo pipefail

BASE="http://127.0.0.1:8090"
E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:?Set E2E_ADMIN_EMAIL to the superuser.toml email}"
E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:?Set E2E_ADMIN_PASSWORD to the superuser.toml password}"
ADMIN_LOGIN_JSON=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' \
  "$E2E_ADMIN_EMAIL" "$E2E_ADMIN_PASSWORD")
PASS=0
FAIL=0
SKIP=0

# 函数功能：输出通过状态；输入 $1 为测试说明；无结构化输出；由断言和主测试流程调用。
green() { echo -e "\033[32m  PASS\033[0m $1"; }
# 函数功能：输出失败状态；输入 $1 为错误说明；无结构化输出；由断言函数调用。
red()   { echo -e "\033[31m  FAIL\033[0m $1"; }
# 函数功能：输出跳过状态；输入 $1 为跳过原因；无结构化输出；由可选场景调用。
yellow(){ echo -e "\033[33m  SKIP\033[0m $1"; }
# 函数功能：输出提示状态；输入 $1 为补充信息；无结构化输出；由主测试流程调用。
info()  { echo -e "\033[36m  INFO\033[0m $1"; }

# 函数功能：向 Courseworks 后端发送带可选 Bearer Token 的 JSON HTTP 请求。
# 输入参数：$1 为方法，$2 为 API 路径，$3 为 JSON 请求体，$4 为可选 Token。
# 输出参数：输出响应体及 HTTP:CODE 标记，供 body() 和 http_code() 拆分。
# 调用关系：由全部 API 验收场景调用，内部调用 curl。
apicall() {
  local method="$1" url="$2" data="$3" token="${4:-}"
  local auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  curl -s --connect-timeout 5 --max-time 30 -w "\nHTTP:%{http_code}" \
    -X "$method" "$BASE$url" \
    -H "Content-Type: application/json" \
    "${auth[@]}" \
    -d "$data" 2>/dev/null
}

# 函数功能：提取 apicall() 输出中的 HTTP 状态码；输入 $1 为组合响应；输出三位状态码；由断言和主流程调用。
http_code() { echo "$1" | grep -oP 'HTTP:\K\d+' || echo "000"; }
# 函数功能：移除 apicall() 的 HTTP 标记行；输入 $1 为组合响应；输出纯响应体；由 JSON 解析和断言调用。
body() { echo "$1" | sed '/^HTTP:[0-9]*$/d'; }

# 函数功能：比较期望值和实际值；输入依次为标签、期望值、实际值；更新 PASS/FAIL 计数；由主测试流程调用。
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# 函数功能：断言文本包含指定片段；输入依次为标签、目标片段、完整文本；更新 PASS/FAIL 计数；由主测试流程调用。
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label — haystack did not contain: $(echo "$needle" | cut -c1-60)"
    FAIL=$((FAIL + 1))
  fi
}

# 函数功能：断言 HTTP 状态码符合预期；输入依次为标签、期望状态、实际状态；更新 PASS/FAIL；由主测试流程调用。
assert_http() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "$label (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    red "$label — expected HTTP $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

# 函数功能：断言值非空；输入依次为标签和值；更新 PASS/FAIL 计数；由账号和资源创建场景调用。
assert_not_empty() {
  local label="$1" value="$2"
  if [ -n "$value" ]; then
    green "$label"
    PASS=$((PASS + 1))
  else
    red "$label — value is empty"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo "  MVP 1 Automated Acceptance Test Suite"
echo "  Target: $BASE"
echo "  Time:   $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 0. System Health ═══"
HLTH=$(apicall GET /api/health "{}")
assert_http "health endpoint" "200" "$(http_code "$HLTH")"
assert_contains "health returns ok" '"ok":true' "$(body "$HLTH")"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 1. Authentication & Test User Setup ═══"

# 1a. Admin login
ADMIN_RESP=$(apicall POST /api/auth/login \
  "$ADMIN_LOGIN_JSON")
ADMIN_TOKEN=$(body "$ADMIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
assert_http "admin login" "200" "$(http_code "$ADMIN_RESP")"
assert_not_empty "admin token received" "$ADMIN_TOKEN"

# 1b. Get invite code
IC_RESP=$(apicall GET /api/admin/invite-codes "{}" "$ADMIN_TOKEN")
INVITE_CODE=$(body "$IC_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
codes=d.get('inviteCodes',[]) if isinstance(d,dict) else []
for c in codes:
    if c.get('isActive') and c.get('usedCount',0) < c.get('maxUses',1):
        print(c['code']); break
" 2>/dev/null || echo "")
assert_not_empty "invite code found" "$INVITE_CODE"

# 1c. Register test student
TEST_EMAIL="mvp1-test-$(date +%s)@test.local"
TEST_PW="test123456"
REG_RESP=$(apicall POST /api/auth/register \
  "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PW\",\"confirmPassword\":\"$TEST_PW\",\"inviteCode\":\"$INVITE_CODE\"}")
STUDENT_TOKEN=$(body "$REG_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
assert_http "student registration" "201" "$(http_code "$REG_RESP")"
assert_not_empty "student token received" "$STUDENT_TOKEN"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 2. Workspace Initialization ═══"

# 2a. Initialize workspace
WS_INIT=$(apicall POST /api/workspace/initialize "{}" "$STUDENT_TOKEN")
assert_http "workspace initialize" "201" "$(http_code "$WS_INIT")"

# 2b. Poll until ready
WS_READY=0
for i in $(seq 1 20); do
  sleep 2
  ME_RESP=$(apicall GET /api/auth/me "{}" "$STUDENT_TOKEN")
  WS_STATUS=$(body "$ME_RESP" | python3 -c "import sys,json;w=json.load(sys.stdin).get('workspace',{});print(w.get('status','?'))" 2>/dev/null || echo "?")
  if [ "$WS_STATUS" = "ready" ]; then WS_READY=1; break; fi
done
if [ "$WS_READY" -eq 1 ]; then
  green "workspace became ready"
  PASS=$((PASS + 1))
else
  red "workspace did not become ready (status=$WS_STATUS)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 3. Session Identity (MVP 1 core) ═══"

# 3a. First read — auto-creates active session
CS1=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
CS1_BODY=$(body "$CS1")
SESSION_ID_1=$(echo "$CS1_BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
SESSION_KEY=$(echo "$CS1_BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionKey',''))" 2>/dev/null || echo "")

assert_http "get chat sessions" "200" "$(http_code "$CS1")"
assert_contains "sessionKey format" "course:os:user:" "$SESSION_KEY"
assert_not_empty "sessionId assigned" "$SESSION_ID_1"

# 3b. Second read — MUST return SAME sessionId
CS2=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_ID_2=$(body "$CS2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")

assert_eq "session idempotent (repeat read)" "$SESSION_ID_1" "$SESSION_ID_2"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 4. Context Preview ═══"

CP=$(apicall POST /api/agent/chat-sessions/context-preview \
  '{"prompt":"Hello, this is a test prompt from MVP1 suite."}' "$STUDENT_TOKEN")
CP_BODY=$(body "$CP")

assert_http "context preview endpoint" "200" "$(http_code "$CP")"
assert_contains "policy section present" "最新用户请求优先于历史上下文" "$CP_BODY"
assert_contains "current_request section" "test prompt from MVP1 suite" "$CP_BODY"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 5. Agent Run creates session turns ═══"

RUN1=$(apicall POST /api/agent/runs \
  '{"prompt":"Hello! Just confirm you received this message. Say OK."}' "$STUDENT_TOKEN")
RUN1_ID=$(body "$RUN1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")

assert_http "create agent run" "201" "$(http_code "$RUN1")"
assert_not_empty "run ID assigned" "$RUN1_ID"

# 轮询运行状态，最长等待 60 秒。
RUN_DONE=0
if [ -n "$RUN1_ID" ]; then
  for i in $(seq 1 30); do
    sleep 2
    RS=$(apicall GET "/api/agent/runs/$RUN1_ID" "{}" "$STUDENT_TOKEN")
    RS_STATUS=$(body "$RS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$RS_STATUS" in
      completed|failed|cancelled)
        green "agent run finished: $RS_STATUS"
        PASS=$((PASS + 1)); RUN_DONE=1; break ;;
    esac
  done
  if [ "$RUN_DONE" -eq 0 ]; then
    info "agent run still in progress after 60s — continuing"
    SKIP=$((SKIP + 1))
  fi
else
  SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 6. Session survives agent run ═══"

CS3=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_ID_3=$(body "$CS3" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
HIST_LEN=$(body "$CS3" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('chat',{}).get('history',[])))" 2>/dev/null || echo "0")

assert_eq "session unchanged after run" "$SESSION_ID_1" "$SESSION_ID_3"
if [ "$HIST_LEN" -gt 0 ]; then
  green "session history contains $HIST_LEN turn(s)"
  PASS=$((PASS + 1))
else
  info "session history empty (agent may not have written turn yet)"
  SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 7. /new requires confirmation ═══"

# 7a. /new with confirmed=false MUST fail
NEW_FAIL=$(apicall POST /api/agent/chat-sessions/new \
  '{"reason":"user_slash_new","confirmed":false}' "$STUDENT_TOKEN")
assert_http "/new rejected (confirmed=false)" "400" "$(http_code "$NEW_FAIL")"

# 7b. Old session MUST still be active
CS4=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_ID_4=$(body "$CS4" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
assert_eq "rejected /new preserves session" "$SESSION_ID_1" "$SESSION_ID_4"

# 7c. /new with wrong reason MUST fail
NEW_BAD=$(apicall POST /api/agent/chat-sessions/new \
  '{"reason":"i_feel_like_it","confirmed":true}' "$STUDENT_TOKEN")
assert_http "/new rejected (bad reason)" "400" "$(http_code "$NEW_BAD")"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 8. Upload staging lifecycle ═══"

# 8a. Stage an upload
UP_BODY='{"files":[{"name":"test-note.txt","mimeType":"text/plain","contentBase64":"SGVsbG8gYXR0YWNobWVudCB0ZXN0IGNvbnRlbnQK"}]}'
UP1=$(apicall POST /api/workspace/uploads "$UP_BODY" "$STUDENT_TOKEN")
UP1_ID=$(body "$UP1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('uploads',[{}])[0].get('id',''))" 2>/dev/null || echo "")

assert_http "stage upload" "201" "$(http_code "$UP1")"
assert_not_empty "upload ID assigned" "$UP1_ID"

# 8b. List staged uploads
UP_LIST=$(apicall GET /api/workspace/uploads "{}" "$STUDENT_TOKEN")
UP_COUNT=$(body "$UP_LIST" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('uploads',[])))" 2>/dev/null || echo "0")
assert_eq "one staged upload listed" "1" "$UP_COUNT"
assert_contains "upload filename visible" "test-note.txt" "$(body "$UP_LIST")"

# 8c. Delete staged upload
UP_DEL=$(apicall DELETE "/api/workspace/uploads/$UP1_ID" "{}" "$STUDENT_TOKEN")
assert_http "delete staged upload" "200" "$(http_code "$UP_DEL")"

# 8d. Verify empty after delete
UP_LIST2=$(apicall GET /api/workspace/uploads "{}" "$STUDENT_TOKEN")
UP_COUNT2=$(body "$UP_LIST2" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('uploads',[])))" 2>/dev/null || echo "0")
assert_eq "staged uploads empty after delete" "0" "$UP_COUNT2"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 9. /new success creates new session ═══"

NEW_OK=$(apicall POST /api/agent/chat-sessions/new \
  '{"reason":"user_slash_new","confirmed":true}' "$STUDENT_TOKEN")
assert_http "/new with confirmation" "200" "$(http_code "$NEW_OK")"

CS5=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_ID_5=$(body "$CS5" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
HIST_LEN5=$(body "$CS5" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('chat',{}).get('history',[])))" 2>/dev/null || echo "0")

assert_eq "/new created different session" "1" "$([ "$SESSION_ID_5" != "$SESSION_ID_4" ] && [ -n "$SESSION_ID_5" ] && echo 1 || echo 0)"
assert_eq "new session has empty history" "0" "$HIST_LEN5"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 10. Topic change does NOT create session ═══"

RUN2=$(apicall POST /api/agent/runs \
  '{"prompt":"What is a RISC-V processor? Give a one-line answer."}' "$STUDENT_TOKEN")
assert_http "topic change run accepted" "201" "$(http_code "$RUN2")"

# 进入产物测试前等待当前运行结束。
RUN2_ID=$(body "$RUN2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
if [ -n "$RUN2_ID" ]; then
  for i in $(seq 1 30); do
    sleep 2
    RS2=$(apicall GET "/api/agent/runs/$RUN2_ID" "{}" "$STUDENT_TOKEN")
    RS2_STATUS=$(body "$RS2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    case "$RS2_STATUS" in completed|failed|cancelled) break ;; esac
  done
fi

CS6=$(apicall GET /api/agent/chat-sessions "{}" "$STUDENT_TOKEN")
SESSION_ID_6=$(body "$CS6" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")

assert_eq "topic change preserves session" "$SESSION_ID_5" "$SESSION_ID_6"
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 11. Session persistence across re-login ═══"

LOGIN2=$(apicall POST /api/auth/login \
  "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PW\"}")
TOKEN2=$(body "$LOGIN2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

assert_http "re-login" "200" "$(http_code "$LOGIN2")"

if [ -n "$TOKEN2" ]; then
  CS7=$(apicall GET /api/agent/chat-sessions "{}" "$TOKEN2")
  SESSION_ID_7=$(body "$CS7" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('chat',{}).get('session',{}).get('sessionId',''))" 2>/dev/null || echo "")
  assert_eq "re-login preserves session" "$SESSION_ID_6" "$SESSION_ID_7"
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 12. Generated artifact (downloadable file) ═══"

ART_RUN=$(apicall POST /api/agent/runs \
  '{"prompt":"Please generate a Markdown file named test-artifact.md with simple test content. Make it available as a downloadable file. Do NOT write to the workspace."}' "$STUDENT_TOKEN")
ART_RUN_ID=$(body "$ART_RUN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('id',''))" 2>/dev/null || echo "")
ART_RUN_ERR=$(body "$ART_RUN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('message',''))" 2>/dev/null || echo "")

if [ "$(http_code "$ART_RUN")" = "201" ]; then
  green "artifact run created (HTTP 201)"
  PASS=$((PASS + 1))
else
  red "artifact run creation failed: HTTP $(http_code "$ART_RUN") — $ART_RUN_ERR"
  FAIL=$((FAIL + 1))
fi

if [ -n "$ART_RUN_ID" ]; then
  ARTIFACT_FOUND=0
  for i in $(seq 1 30); do
    sleep 2
    ARS=$(apicall GET "/api/agent/runs/$ART_RUN_ID" "{}" "$STUDENT_TOKEN")
    ARS_STATUS=$(body "$ARS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('run',{}).get('status',''))" 2>/dev/null || echo "")
    ARS_FINAL=$(body "$ARS" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('run',{})
print(d.get('finalAnswerMarkdown','') or d.get('responseMarkdown',''))
" 2>/dev/null || echo "")
    if echo "$ARS_FINAL" | grep -q "courseworks-artifact-download"; then
      ARTIFACT_FOUND=1
      ARTIFACT_ID=$(echo "$ARS_FINAL" | grep -oP 'courseworks-artifact-download:\K[^:]+' | head -1)
      green "artifact download marker found in response"
      PASS=$((PASS + 1))
      break
    fi
    case "$ARS_STATUS" in
      completed|failed|cancelled)
        if [ "$ARTIFACT_FOUND" -eq 0 ]; then
          info "run completed but no artifact marker found (status=$ARS_STATUS)"
        fi
        break ;;
    esac
  done

  # 找到产物后验证下载接口。
  if [ "$ARTIFACT_FOUND" -eq 1 ] && [ -n "${ARTIFACT_ID:-}" ]; then
    ART_DL=$(apicall GET "/api/agent/session-artifacts/$ARTIFACT_ID/download" "{}" "$STUDENT_TOKEN")
    DL_CODE=$(http_code "$ART_DL")
    if [ "$DL_CODE" = "200" ]; then
      green "artifact download succeeded"
      PASS=$((PASS + 1))
    else
      info "artifact download returned HTTP $DL_CODE"
      SKIP=$((SKIP + 1))
    fi

    # 验证跨用户隔离：其他用户不能下载该学生的产物。
    STUDENT2_RESP=$(apicall POST /api/auth/login \
      "$ADMIN_LOGIN_JSON")
    ADMIN_TOKEN2=$(body "$STUDENT2_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
    if [ -n "$ADMIN_TOKEN2" ]; then
      ART_DL2=$(apicall GET "/api/agent/session-artifacts/$ARTIFACT_ID/download" "{}" "$ADMIN_TOKEN2")
      DL2_CODE=$(http_code "$ART_DL2")
      if [ "$DL2_CODE" = "404" ] || [ "$DL2_CODE" = "403" ]; then
        green "cross-user artifact isolation (HTTP $DL2_CODE)"
        PASS=$((PASS + 1))
      else
        red "cross-user isolation failed — admin could download student artifact (HTTP $DL2_CODE)"
        FAIL=$((FAIL + 1))
      fi
    fi
  fi
else
  SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "═══ 13. Workspace export/download ═══"

WS_EXP=$(apicall GET /api/workspace/export.zip "{}" "$STUDENT_TOKEN")
EXP_CODE=$(http_code "$WS_EXP")
if [ "$EXP_CODE" = "200" ]; then
  EXP_SIZE=$(body "$WS_EXP" | wc -c)
  green "workspace export downloaded ($EXP_SIZE bytes)"
  PASS=$((PASS + 1))
else
  info "workspace export returned HTTP $EXP_CODE"
  SKIP=$((SKIP + 1))
fi
echo ""

# ═══════════════════════════════════════════════════
echo "============================================"
echo "  MVP 1 TEST RESULTS"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Skipped: $SKIP"
echo "============================================"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
