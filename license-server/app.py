# RAuto 授权服务（激活码）
# 部署于 us-vps，监听 127.0.0.1:8811，由 nginx /57dad064af8185c3/rauto/ 反代。
#
# 客户端接口（无需鉴权）：
#   POST /api/activate  {code, phone, device_id, device_name?}  首次激活（绑定设备）
#   POST /api/verify    {code, phone, device_id}               启动校验
#   POST /api/rebind    {code, phone, device_id, device_name?} 换绑到当前设备（旧设备立即失效）
#
# 管理接口（Authorization: Bearer <ADMIN_PASSWORD>）：
#   GET  /admin/                       Web 管理页
#   GET  /admin/api/codes              列表
#   POST /admin/api/codes              生成 {phone, days(0=永久), note?}
#   POST /admin/api/codes/{code}/disable | /enable | /unbind
#   DELETE /admin/api/codes/{code}

import hmac
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("LICENSE_DB", str(BASE_DIR / "license.db"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 去掉易混淆的 I/O/0/1

app = FastAPI(title="RAuto License Server", docs_url=None, redoc_url=None)


def now() -> int:
    return int(time.time())


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS codes (
                code TEXT PRIMARY KEY,
                phone TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
                duration_days INTEGER,                   -- NULL = 永久
                note TEXT NOT NULL DEFAULT '',
                device_id TEXT,                          -- NULL = 未激活
                device_name TEXT,
                created_at INTEGER NOT NULL,
                activated_at INTEGER,
                expires_at INTEGER,                      -- NULL = 永久，首次激活时按 duration_days 计算
                last_verify_at INTEGER
            )
            """
        )


init_db()

# ── 简单限流：客户端接口每 IP 每分钟 30 次 ──
_rate: dict[str, list[float]] = {}


def rate_limited(ip: str) -> bool:
    t = now()
    bucket = [x for x in _rate.get(ip, []) if t - x < 60]
    if len(bucket) >= 30:
        _rate[ip] = bucket
        return True
    bucket.append(t)
    _rate[ip] = bucket
    return False


def reply(ok: bool, error: str = "", message: str = "", **extra) -> JSONResponse:
    body: dict[str, object] = {"ok": ok}
    if error:
        body["error"] = error
    if message:
        body["message"] = message
    body.update(extra)
    return JSONResponse(body)


def check_code_usable(row: sqlite3.Row, phone: str) -> JSONResponse | None:
    """公共校验：状态/手机号/有效期。返回 None 表示可用。"""
    if row["status"] == "disabled":
        return reply(False, "DISABLED", "激活码已被禁用，请联系卖家")
    if not hmac.compare_digest(row["phone"], phone):
        return reply(False, "PHONE_MISMATCH", "手机号与激活码不匹配")
    exp = row["expires_at"]
    if exp is not None and now() > exp:
        return reply(False, "EXPIRED", "激活码已过期，请联系卖家续期")
    return None


def normalize_phone(raw: object) -> str:
    phone = str(raw or "").strip()
    return phone if re.fullmatch(r"\d{5,15}", phone) else ""


def normalize_code(raw: object) -> str:
    return str(raw or "").strip().upper()


def normalize_device(raw: object) -> str:
    return str(raw or "").strip()


def get_code_row(code: str) -> sqlite3.Row | None:
    with db() as conn:
        return conn.execute("SELECT * FROM codes WHERE code = ?", (code,)).fetchone()


# ════════════════ 客户端接口 ════════════════


@app.post("/api/activate")
async def activate(request: Request):
    if rate_limited(request.client.host if request.client else "?"):
        return reply(False, "RATE_LIMITED", "请求过于频繁，请稍后再试")
    data = await request.json()
    code, phone = normalize_code(data.get("code")), normalize_phone(data.get("phone"))
    device_id = normalize_device(data.get("device_id"))
    device_name = str(data.get("device_name") or "")[:100]
    if not code or not phone or not device_id:
        return reply(False, "INVALID_INPUT", "请填写完整的手机号和激活码")

    row = get_code_row(code)
    if row is None:
        return reply(False, "CODE_NOT_FOUND", "激活码不存在")
    if (err := check_code_usable(row, phone)) is not None:
        return err

    bound = row["device_id"]
    if bound and bound != device_id:
        return reply(False, "DEVICE_CONFLICT", "该激活码已在其他设备上使用")

    t = now()
    activated_at = row["activated_at"] or t
    expires_at = row["expires_at"]
    if expires_at is None and row["duration_days"]:
        expires_at = activated_at + int(row["duration_days"]) * 86400
    with db() as conn:
        conn.execute(
            "UPDATE codes SET device_id=?, device_name=?, activated_at=?, expires_at=?, last_verify_at=? WHERE code=?",
            (device_id, device_name, activated_at, expires_at, t, code),
        )
    return reply(True, expires_at=expires_at, message="激活成功")


@app.post("/api/verify")
async def verify(request: Request):
    if rate_limited(request.client.host if request.client else "?"):
        return reply(False, "RATE_LIMITED", "请求过于频繁，请稍后再试")
    data = await request.json()
    code, phone = normalize_code(data.get("code")), normalize_phone(data.get("phone"))
    device_id = normalize_device(data.get("device_id"))
    if not code or not phone or not device_id:
        return reply(False, "INVALID_INPUT", "授权信息不完整，请重新激活")

    row = get_code_row(code)
    if row is None:
        return reply(False, "CODE_NOT_FOUND", "激活码不存在")
    if (err := check_code_usable(row, phone)) is not None:
        return err
    if row["device_id"] is None:
        return reply(False, "NOT_ACTIVATED", "激活码尚未激活，请重新激活")
    if row["device_id"] != device_id:
        return reply(False, "DEVICE_CONFLICT", "该激活码已在其他设备上使用")

    with db() as conn:
        conn.execute("UPDATE codes SET last_verify_at=? WHERE code=?", (now(), code))
    return reply(True, expires_at=row["expires_at"])


@app.post("/api/rebind")
async def rebind(request: Request):
    if rate_limited(request.client.host if request.client else "?"):
        return reply(False, "RATE_LIMITED", "请求过于频繁，请稍后再试")
    data = await request.json()
    code, phone = normalize_code(data.get("code")), normalize_phone(data.get("phone"))
    device_id = normalize_device(data.get("device_id"))
    device_name = str(data.get("device_name") or "")[:100]
    if not code or not phone or not device_id:
        return reply(False, "INVALID_INPUT", "请填写完整的手机号和激活码")

    row = get_code_row(code)
    if row is None:
        return reply(False, "CODE_NOT_FOUND", "激活码不存在")
    if (err := check_code_usable(row, phone)) is not None:
        return err

    with db() as conn:
        conn.execute(
            "UPDATE codes SET device_id=?, device_name=?, last_verify_at=? WHERE code=?",
            (device_id, device_name, now(), code),
        )
    return reply(True, expires_at=row["expires_at"], message="已换绑到本机，原设备上的授权已失效")


# ════════════════ 管理接口 ════════════════


def admin_ok(request: Request) -> bool:
    if not ADMIN_PASSWORD:
        return False
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    return bool(token) and hmac.compare_digest(token, ADMIN_PASSWORD)


def require_admin(request: Request) -> JSONResponse | None:
    if not admin_ok(request):
        return reply(False, "UNAUTHORIZED", "管理员密码错误")
    return None


@app.get("/admin/", response_class=HTMLResponse)
async def admin_page():
    return HTMLResponse((BASE_DIR / "admin.html").read_text(encoding="utf-8"))


def code_view(r: sqlite3.Row) -> dict:
    t = now()
    if r["status"] == "disabled":
        state = "已禁用"
    elif r["expires_at"] is not None and t > r["expires_at"]:
        state = "已过期"
    elif r["activated_at"]:
        state = "已激活"
    else:
        state = "未激活"
    return {
        "code": r["code"],
        "phone": r["phone"],
        "state": state,
        "duration_days": r["duration_days"],
        "note": r["note"],
        "device_id": (r["device_id"] or "")[:12],
        "device_name": r["device_name"] or "",
        "created_at": r["created_at"],
        "activated_at": r["activated_at"],
        "expires_at": r["expires_at"],
        "last_verify_at": r["last_verify_at"],
    }


@app.get("/admin/api/codes")
async def admin_list(request: Request):
    if (err := require_admin(request)) is not None:
        return err
    with db() as conn:
        rows = conn.execute("SELECT * FROM codes ORDER BY created_at DESC").fetchall()
    return {"ok": True, "codes": [code_view(r) for r in rows]}


@app.post("/admin/api/codes")
async def admin_create(request: Request):
    if (err := require_admin(request)) is not None:
        return err
    data = await request.json()
    phone = normalize_phone(data.get("phone"))
    if not phone:
        return reply(False, "INVALID_INPUT", "手机号格式不正确")
    days_raw = data.get("days", 0)
    days = int(days_raw) if str(days_raw).isdigit() and int(days_raw) > 0 else None
    note = str(data.get("note") or "")[:200]

    code = "-".join("".join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(4))
    with db() as conn:
        conn.execute(
            "INSERT INTO codes (code, phone, duration_days, note, created_at) VALUES (?,?,?,?,?)",
            (code, phone, days, note, now()),
        )
    return reply(True, code=code, message="生成成功")


@app.post("/admin/api/codes/{code}/disable")
async def admin_disable(code: str, request: Request):
    if (err := require_admin(request)) is not None:
        return err
    with db() as conn:
        cur = conn.execute("UPDATE codes SET status='disabled' WHERE code=?", (normalize_code(code),))
    return reply(cur.rowcount > 0, message="已禁用" if cur.rowcount else "激活码不存在")


@app.post("/admin/api/codes/{code}/enable")
async def admin_enable(code: str, request: Request):
    if (err := require_admin(request)) is not None:
        return err
    with db() as conn:
        cur = conn.execute("UPDATE codes SET status='active' WHERE code=?", (normalize_code(code),))
    return reply(cur.rowcount > 0, message="已启用" if cur.rowcount else "激活码不存在")


@app.post("/admin/api/codes/{code}/unbind")
async def admin_unbind(code: str, request: Request):
    if (err := require_admin(request)) is not None:
        return err
    with db() as conn:
        cur = conn.execute(
            "UPDATE codes SET device_id=NULL, device_name=NULL WHERE code=?", (normalize_code(code),)
        )
    return reply(cur.rowcount > 0, message="已解绑设备" if cur.rowcount else "激活码不存在")


@app.delete("/admin/api/codes/{code}")
async def admin_delete(code: str, request: Request):
    if (err := require_admin(request)) is not None:
        return err
    with db() as conn:
        cur = conn.execute("DELETE FROM codes WHERE code=?", (normalize_code(code),))
    return reply(cur.rowcount > 0, message="已删除" if cur.rowcount else "激活码不存在")
