#!/usr/bin/env bash
# 文件作用：用模拟 docker/iptables 命令验证受限网络脚本生成的 INPUT 规则顺序。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$TEMP_DIR/bin"

cat >"$TEMP_DIR/bin/docker" <<'EOF'
#!/bin/sh
# 测试中假定受限 Docker network 已存在。
exit 0
EOF

cat >"$TEMP_DIR/bin/iptables" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$IPTABLES_LOG"
case "${1:-} ${2:-}" in
  "-D INPUT")
    if printf '%s\n' "$*" | grep -q -- '--ctstate ESTABLISHED,RELATED'; then rule=ACCEPT; else rule=REJECT; fi
    if grep -qx "$rule" "$IPTABLES_STATE"; then
      grep -vx "$rule" "$IPTABLES_STATE" >"$IPTABLES_STATE.next" || true
      mv "$IPTABLES_STATE.next" "$IPTABLES_STATE"
      exit 0
    fi
    exit 1
    ;;
  "-I INPUT")
    if printf '%s\n' "$*" | grep -q -- '--ctstate ESTABLISHED,RELATED'; then rule=ACCEPT; else rule=REJECT; fi
    { printf '%s\n' "$rule"; cat "$IPTABLES_STATE"; } >"$IPTABLES_STATE.next"
    mv "$IPTABLES_STATE.next" "$IPTABLES_STATE"
    ;;
esac
exit 0
EOF
chmod +x "$TEMP_DIR/bin/docker" "$TEMP_DIR/bin/iptables"

IPTABLES_LOG="$TEMP_DIR/iptables.log"
IPTABLES_STATE="$TEMP_DIR/input.state"
export IPTABLES_LOG IPTABLES_STATE
printf 'REJECT\nACCEPT\n' >"$IPTABLES_STATE"

run_setup() {
  PATH="$TEMP_DIR/bin:$PATH" \
  DOCKER_RESTRICTED_SUBNET="172.31.0.0/24" \
    sh "$ROOT/docker/toolbox/setup-restricted-network.sh" >/dev/null
}

run_setup
run_setup

mapfile -t input_inserts < <(grep '^-I INPUT 1 ' "$TEMP_DIR/iptables.log")
test "${#input_inserts[@]}" -eq 4
[[ "${input_inserts[0]}" == *'-j REJECT' ]]
[[ "${input_inserts[1]}" == *'--ctstate ESTABLISHED,RELATED -j ACCEPT' ]]
[[ "${input_inserts[2]}" == *'-j REJECT' ]]
[[ "${input_inserts[3]}" == *'--ctstate ESTABLISHED,RELATED -j ACCEPT' ]]

# 每次都插入位置 1，因此最终链顺序与调用顺序相反；重复执行也不产生重复规则。
mapfile -t final_rules <"$IPTABLES_STATE"
test "${#final_rules[@]}" -eq 2
test "${final_rules[0]}" = "ACCEPT"
test "${final_rules[1]}" = "REJECT"
printf 'Restricted network INPUT rule ordering test passed.\n'
