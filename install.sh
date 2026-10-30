#!/bin/bash
# VPanel installer. Run as root:  bash install.sh
[ "$EUID" -ne 0 ] && { echo "Run as root"; exit 1; }
DIR=/opt/vpanel; SRC="$(cd "$(dirname "$0")" && pwd)"
PUBIP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
deps(){ apt-get update -y
 apt-get install -y curl nodejs npm qemu-kvm libvirt-daemon-system libvirt-clients virtinst cloud-image-utils lvm2 lxd-installer snapd iptables 2>/dev/null || apt-get install -y curl nodejs npm qemu-kvm libvirt-daemon-system virtinst cloud-image-utils lvm2 iptables
 command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
 command -v lxc >/dev/null || snap install lxd; lxd init --auto 2>/dev/null
 systemctl enable --now libvirtd docker; virsh net-start default 2>/dev/null; virsh net-autostart default
 echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-vpanel.conf; sysctl -p /etc/sysctl.d/99-vpanel.conf; }
svc(){ cat > /etc/systemd/system/$1.service <<EOS
[Unit]
Description=$1
After=network.target
[Service]
WorkingDirectory=$2
Environment=$3
ExecStart=/usr/bin/node $4
Restart=always
[Install]
WantedBy=multi-user.target
EOS
 systemctl daemon-reload; systemctl enable --now $1; }
agent(){ TOKEN=$(openssl rand -hex 16); mkdir -p $DIR/agent; cp $SRC/agent/agent.js $DIR/agent/
 svc vpanel-agent $DIR/agent "AGENT_TOKEN=$TOKEN PUBLIC_IP=$PUBIP" "$DIR/agent/agent.js"; echo $TOKEN > $DIR/agent.token; }
while true; do clear; echo "=============================="; echo "        VPanel Installer"; echo "=============================="
 echo " 1) Install Panel + Local Node (all-in-one)"; echo " 2) Install Node Only (connect to a remote panel, e.g. Render)"
 echo " 3) Uninstall Everything"; echo " 4) Show Node Token / Info"; echo " 0) Exit"; read -p "Choose: " c
 case $c in
 1) deps; agent; cp -r $SRC/* $DIR/; cd $DIR && npm install --omit=dev
    AP=$(openssl rand -hex 6); svc vpanel $DIR "PORT=3000 ADMIN_PASS=$AP LOCAL_NODE_TOKEN=$(cat $DIR/agent.token)" "$DIR/server.js"
    echo "Panel: http://$PUBIP:3000  | admin / $AP  (Local Node added automatically)"; read -p "Enter..." ;;
 2) deps; agent; echo "Add this node in panel -> Nodes -> Add:"; echo "Host: $PUBIP  Port: 8443  Token: $(cat $DIR/agent.token)"; ufw allow 8443/tcp 2>/dev/null; read -p "Enter..." ;;
 3) read -p "Type YES to remove panel, agent and ALL VPS: " y; [ "$y" = YES ] || continue
    systemctl disable --now vpanel vpanel-agent 2>/dev/null; rm -f /etc/systemd/system/vpanel*.service
    for v in $(virsh list --all --name | grep '^vps-'); do virsh destroy $v; virsh undefine $v --remove-all-storage; done
    for v in $(docker ps -a --format '{{.Names}}' | grep '^vps-'); do docker rm -f $v; done
    for v in $(lxc list -c n --format csv 2>/dev/null | grep '^vps-'); do lxc delete -f $v; done
    rm -rf $DIR /var/lib/vpanel; echo "Uninstalled."; read -p "Enter..." ;;
 4) cat $DIR/agent.token 2>/dev/null; echo "Host: $PUBIP Port: 8443"; read -p "Enter..." ;;
 0) exit ;; esac; done
