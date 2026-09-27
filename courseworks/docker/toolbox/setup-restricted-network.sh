#!/bin/sh
# 文件作用：创建 Courseworks 受限 Docker 网络，并配置容器出站和宿主机访问防火墙规则。
# 模块位置：docker/toolbox，属于沙箱网络基础设施脚本。
# 重要流程：创建 bridge 网络、维护 iptables 链并阻止学生容器访问内网和宿主服务；本文件不定义独立函数。
set -eu

NETWORK_NAME="${DOCKER_RESTRICTED_NETWORK:-courseworks-restricted}"
SUBNET="${DOCKER_RESTRICTED_SUBNET:-172.30.0.0/24}"
DIRECT_IFACE="${DOCKER_DIRECT_IFACE:-eno1}"
CHAIN="COURSEWORKS_EGRESS"

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --opt com.docker.network.bridge.enable_ip_masquerade=true \
    "$NETWORK_NAME" >/dev/null
fi

# 允许常见教学流量，同时阻止访问宿主机、局域网、元数据端点和其他私有 Docker 网络。
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$CHAIN" -d 10.0.0.0/8 -j REJECT
iptables -A "$CHAIN" -d 100.64.0.0/10 -j REJECT
iptables -A "$CHAIN" -d 127.0.0.0/8 -j REJECT
iptables -A "$CHAIN" -d 169.254.0.0/16 -j REJECT
iptables -A "$CHAIN" -d 172.16.0.0/12 -j REJECT
iptables -A "$CHAIN" -d 192.168.0.0/16 -j REJECT
# 学生容器的新建出站连接必须经过物理直连接口，避免 v2ray/tun0 策略路由静默接管 LLM/API 流量。
iptables -A "$CHAIN" -o "$DIRECT_IFACE" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -o "$DIRECT_IFACE" -p tcp -m multiport --dports 53,80,443 -j ACCEPT
iptables -A "$CHAIN" -o "$DIRECT_IFACE" -p udp --dport 123 -j ACCEPT
iptables -A "$CHAIN" -o "$DIRECT_IFACE" -p icmp -j ACCEPT
iptables -A "$CHAIN" -j REJECT

if ! iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; then
  iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"
fi

# 发往 Docker 宿主机本身的流量经过 INPUT 而不是 DOCKER-USER，因此需要单独阻断，
# 防止学生访问宿主机上的 Nginx、MySQL、SSH 或后端管理端口。先移除旧规则再按确定
# 顺序插入：允许宿主机主动连接（例如认证后的 VNC bridge）的回包，拒绝容器发起的新连接。
while iptables -D INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do :; done
while iptables -D INPUT -s "$SUBNET" -j REJECT 2>/dev/null; do :; done
iptables -I INPUT 1 -s "$SUBNET" -j REJECT
iptables -I INPUT 1 -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

echo "Restricted Docker network '$NETWORK_NAME' is ready on $SUBNET via $DIRECT_IFACE."
