#!/bin/bash
# RAuto 授权服务部署：等 SSH 恢复 → 传文件 → systemd → nginx → 端到端测试
set -u
cd "$(dirname "$0")"
SSH="ssh -o ConnectTimeout=30 -o BatchMode=yes us-vps"
SCP="scp -o ConnectTimeout=30 -o BatchMode=yes"
BASE_URL="http://199.102.216.216/57dad064af8185c3/rauto"
ADMIN_PWD=$(grep ADMIN_PASSWORD .env | cut -d= -f2)

echo "=== [1/5] 等待 VPS SSH 恢复（最长 25 分钟）==="
for i in $(seq 1 50); do
  if $SSH 'echo SSH_OK' 2>/dev/null | grep -q SSH_OK; then
    echo "SSH 恢复（第 $i 次尝试）"
    break
  fi
  sleep 30
  if [ "$i" -eq 50 ]; then echo "SSH 始终未恢复，放弃"; exit 1; fi
done

echo "=== [2/5] 上传文件 ==="
$SSH 'mkdir -p /opt/rauto-license' || exit 1
$SCP rauto-license admin.html us-vps:/opt/rauto-license/ || exit 1
$SCP rauto-license.service us-vps:/etc/systemd/system/ || exit 1
$SSH 'test -f /opt/rauto-license/.env || echo MISSING_ENV' | grep -q MISSING && $SCP .env us-vps:/opt/rauto-license/.env
$SSH 'chmod 600 /opt/rauto-license/.env; chmod +x /opt/rauto-license/rauto-license'

echo "=== [3/5] systemd ==="
$SSH 'systemctl daemon-reload && systemctl enable --now rauto-license && sleep 1 && systemctl is-active rauto-license'

echo "=== [4/5] nginx ==="
$SSH 'python3 - <<"PYEOF"
conf = "/etc/nginx/sites-enabled/proxy-config"
text = open(conf).read()
marker = "# RAuto 授权服务"
block = """
    # RAuto 授权服务（Go 127.0.0.1:8811）
    location = /57dad064af8185c3/rauto {
        return 301 /57dad064af8185c3/rauto/;
    }
    location /57dad064af8185c3/rauto/ {
        proxy_pass http://127.0.0.1:8811/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
"""
if marker in text:
    print("nginx block already present")
else:
    anchor = "    # 原始文件（保留兼容）"
    assert anchor in text, "anchor not found"
    text = text.replace(anchor, block + "\n" + anchor, 1)
    open(conf, "w").write(text)
    print("nginx block inserted")
PYEOF
nginx -t && systemctl reload nginx && echo NGINX_OK'

echo "=== [5/5] 端到端测试（走公网 nginx）==="
sleep 1
curl -s -o /dev/null -w "admin页: %{http_code}\n" "$BASE_URL/admin/"
GEN=$(curl -s -X POST "$BASE_URL/admin/api/codes" -H "Authorization: Bearer $ADMIN_PWD" -H 'Content-Type: application/json' -d '{"phone":"13800138000","days":30,"note":"部署自测"}')
echo "生成: $GEN"
CODE=$(echo "$GEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
echo "激活A: $(curl -s -X POST "$BASE_URL/api/activate" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"phone\":\"13800138000\",\"device_id\":\"e2e-A\",\"device_name\":\"test-A\"}")"
echo "校验A: $(curl -s -X POST "$BASE_URL/api/verify" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"phone\":\"13800138000\",\"device_id\":\"e2e-A\"}")"
echo "冲突B: $(curl -s -X POST "$BASE_URL/api/activate" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"phone\":\"13800138000\",\"device_id\":\"e2e-B\"}")"
echo "换绑B: $(curl -s -X POST "$BASE_URL/api/rebind" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"phone\":\"13800138000\",\"device_id\":\"e2e-B\"}")"
echo "A失效: $(curl -s -X POST "$BASE_URL/api/verify" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"phone\":\"13800138000\",\"device_id\":\"e2e-A\"}")"
echo "删除: $(curl -s -X DELETE "$BASE_URL/admin/api/codes/$CODE" -H "Authorization: Bearer $ADMIN_PWD")"
echo "=== DEPLOY_DONE ==="
