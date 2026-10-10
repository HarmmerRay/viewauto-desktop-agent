// RAuto 授权服务（激活码）— Go 单二进制版
// 部署于 us-vps，监听 127.0.0.1:8811，由 nginx /57dad064af8185c3/rauto/ 反代。
//
// 客户端接口（无需鉴权）：
//   POST /api/activate  {code, device_id, device_name?}  首次激活（绑定设备）
//   POST /api/verify    {code, device_id}                启动校验
//   POST /api/rebind    {code, device_id, device_name?}  换绑到当前设备（旧设备立即失效）
//
// 管理接口（Authorization: Bearer <ADMIN_PASSWORD>）：
//   GET    /admin/                        Web 管理页
//   GET    /admin/api/codes               列表
//   POST   /admin/api/codes               生成 {days(0=永久), note?}
//   POST   /admin/api/codes/{code}/disable | enable | unbind
//   DELETE /admin/api/codes/{code}
package main

import (
	"crypto/subtle"
	"database/sql"
	_ "embed"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed admin.html
var adminHTML []byte

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去掉易混淆的 I/O/0/1

var (
	db            *sql.DB
	adminPassword = os.Getenv("ADMIN_PASSWORD")
)

// ── 简单限流：客户端接口每 IP 每分钟 30 次 ──
var rateMu sync.Mutex
var rateMap = map[string][]int64{}

func rateLimited(ip string) bool {
	rateMu.Lock()
	defer rateMu.Unlock()
	now := time.Now().Unix()
	kept := rateMap[ip][:0]
	for _, t := range rateMap[ip] {
		if now-t < 60 {
			kept = append(kept, t)
		}
	}
	if len(kept) >= 30 {
		rateMap[ip] = kept
		return true
	}
	rateMap[ip] = append(kept, now)
	return false
}

func reply(w http.ResponseWriter, ok bool, errCode, message string, extra map[string]any) {
	body := map[string]any{"ok": ok}
	if errCode != "" {
		body["error"] = errCode
	}
	if message != "" {
		body["message"] = message
	}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(body)
}

type codeRow struct {
	Code         string
	Phone        string
	Status       string
	DurationDays sql.NullInt64
	Note         string
	DeviceID     sql.NullString
	DeviceName   sql.NullString
	CreatedAt    int64
	ActivatedAt  sql.NullInt64
	ExpiresAt    sql.NullInt64
	LastVerifyAt sql.NullInt64
}

func getCodeRow(code string) (*codeRow, error) {
	var r codeRow
	err := db.QueryRow(
		`SELECT code, phone, status, duration_days, note, device_id, device_name,
		        created_at, activated_at, expires_at, last_verify_at
		 FROM codes WHERE code = ?`, code).
		Scan(&r.Code, &r.Phone, &r.Status, &r.DurationDays, &r.Note, &r.DeviceID,
			&r.DeviceName, &r.CreatedAt, &r.ActivatedAt, &r.ExpiresAt, &r.LastVerifyAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// checkUsable 公共校验：状态/有效期。返回 "" 表示可用。
func checkUsable(w http.ResponseWriter, r *codeRow) string {
	if r.Status == "disabled" {
		reply(w, false, "DISABLED", "激活码已被禁用，请联系卖家", nil)
		return "DISABLED"
	}
	if r.ExpiresAt.Valid && time.Now().Unix() > r.ExpiresAt.Int64 {
		reply(w, false, "EXPIRED", "激活码已过期，请联系卖家续期", nil)
		return "EXPIRED"
	}
	return ""
}

type clientReq struct {
	Code       string `json:"code"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
}

func parseClientReq(w http.ResponseWriter, r *http.Request) (*clientReq, bool) {
	var req clientReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		reply(w, false, "INVALID_INPUT", "请求格式错误", nil)
		return nil, false
	}
	req.Code = strings.ToUpper(strings.TrimSpace(req.Code))
	req.DeviceID = strings.TrimSpace(req.DeviceID)
	if len(req.DeviceName) > 100 {
		req.DeviceName = req.DeviceName[:100]
	}
	if req.Code == "" || req.DeviceID == "" {
		reply(w, false, "INVALID_INPUT", "请填写激活码", nil)
		return nil, false
	}
	return &req, true
}

func clientIP(r *http.Request) string {
	// nginx 反代会带 X-Real-IP / X-Forwarded-For
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return xr
	}
	host, _, _ := strings.Cut(r.RemoteAddr, ":")
	return host
}

func clientGuard(w http.ResponseWriter, r *http.Request) (*clientReq, bool) {
	if r.Method != http.MethodPost {
		reply(w, false, "METHOD", "method not allowed", nil)
		return nil, false
	}
	if rateLimited(clientIP(r)) {
		reply(w, false, "RATE_LIMITED", "请求过于频繁，请稍后再试", nil)
		return nil, false
	}
	return parseClientReq(w, r)
}

func handleActivate(w http.ResponseWriter, r *http.Request) {
	req, ok := clientGuard(w, r)
	if !ok {
		return
	}
	row, err := getCodeRow(req.Code)
	if err != nil {
		reply(w, false, "CODE_NOT_FOUND", "激活码不存在", nil)
		return
	}
	if checkUsable(w, row) != "" {
		return
	}
	if row.DeviceID.Valid && row.DeviceID.String != req.DeviceID {
		reply(w, false, "DEVICE_CONFLICT", "该激活码已在其他设备上使用", nil)
		return
	}
	now := time.Now().Unix()
	activatedAt := now
	if row.ActivatedAt.Valid {
		activatedAt = row.ActivatedAt.Int64
	}
	expiresAt := row.ExpiresAt
	if !expiresAt.Valid && row.DurationDays.Valid {
		expiresAt = sql.NullInt64{Int64: activatedAt + row.DurationDays.Int64*86400, Valid: true}
	}
	db.Exec(`UPDATE codes SET device_id=?, device_name=?, activated_at=?, expires_at=?, last_verify_at=? WHERE code=?`,
		req.DeviceID, req.DeviceName, activatedAt, nullableInt(expiresAt), now, req.Code)
	extra := map[string]any{}
	if expiresAt.Valid {
		extra["expires_at"] = expiresAt.Int64
	}
	reply(w, true, "", "激活成功", extra)
}

func handleVerify(w http.ResponseWriter, r *http.Request) {
	req, ok := clientGuard(w, r)
	if !ok {
		return
	}
	row, err := getCodeRow(req.Code)
	if err != nil {
		reply(w, false, "CODE_NOT_FOUND", "激活码不存在", nil)
		return
	}
	if checkUsable(w, row) != "" {
		return
	}
	if !row.DeviceID.Valid {
		reply(w, false, "NOT_ACTIVATED", "激活码尚未激活，请重新激活", nil)
		return
	}
	if row.DeviceID.String != req.DeviceID {
		reply(w, false, "DEVICE_CONFLICT", "该激活码已在其他设备上使用", nil)
		return
	}
	db.Exec(`UPDATE codes SET last_verify_at=? WHERE code=?`, time.Now().Unix(), req.Code)
	extra := map[string]any{}
	if row.ExpiresAt.Valid {
		extra["expires_at"] = row.ExpiresAt.Int64
	}
	reply(w, true, "", "", extra)
}

func handleRebind(w http.ResponseWriter, r *http.Request) {
	req, ok := clientGuard(w, r)
	if !ok {
		return
	}
	row, err := getCodeRow(req.Code)
	if err != nil {
		reply(w, false, "CODE_NOT_FOUND", "激活码不存在", nil)
		return
	}
	if checkUsable(w, row) != "" {
		return
	}
	db.Exec(`UPDATE codes SET device_id=?, device_name=?, last_verify_at=? WHERE code=?`,
		req.DeviceID, req.DeviceName, time.Now().Unix(), req.Code)
	extra := map[string]any{}
	if row.ExpiresAt.Valid {
		extra["expires_at"] = row.ExpiresAt.Int64
	}
	reply(w, true, "", "已换绑到本机，原设备上的授权已失效", extra)
}

func nullableInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}

// ════════════════ 管理接口 ════════════════

func adminOK(r *http.Request) bool {
	if adminPassword == "" {
		return false
	}
	auth := r.Header.Get("Authorization")
	token := strings.TrimPrefix(auth, "Bearer ")
	if token == "" || token == auth {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(adminPassword)) == 1
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !adminOK(r) {
		reply(w, false, "UNAUTHORIZED", "管理员密码错误", nil)
		return false
	}
	return true
}

func handleAdminPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(adminHTML)
}

func codeState(r *codeRow) string {
	if r.Status == "disabled" {
		return "已禁用"
	}
	if r.ExpiresAt.Valid && time.Now().Unix() > r.ExpiresAt.Int64 {
		return "已过期"
	}
	if r.ActivatedAt.Valid {
		return "已激活"
	}
	return "未激活"
}

func handleAdminList(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	rows, err := db.Query(`SELECT code, phone, status, duration_days, note, device_id, device_name,
		created_at, activated_at, expires_at, last_verify_at FROM codes ORDER BY created_at DESC`)
	if err != nil {
		reply(w, false, "DB", "查询失败", nil)
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var c codeRow
		rows.Scan(&c.Code, &c.Phone, &c.Status, &c.DurationDays, &c.Note, &c.DeviceID,
			&c.DeviceName, &c.CreatedAt, &c.ActivatedAt, &c.ExpiresAt, &c.LastVerifyAt)
		item := map[string]any{
			"code": c.Code, "phone": c.Phone, "state": codeState(&c), "note": c.Note,
			"created_at": c.CreatedAt,
		}
		if c.DurationDays.Valid {
			item["duration_days"] = c.DurationDays.Int64
		}
		if c.DeviceID.Valid {
			d := c.DeviceID.String
			if len(d) > 12 {
				d = d[:12]
			}
			item["device_id"] = d
		}
		if c.DeviceName.Valid {
			item["device_name"] = c.DeviceName.String
		}
		if c.ActivatedAt.Valid {
			item["activated_at"] = c.ActivatedAt.Int64
		}
		if c.ExpiresAt.Valid {
			item["expires_at"] = c.ExpiresAt.Int64
		}
		if c.LastVerifyAt.Valid {
			item["last_verify_at"] = c.LastVerifyAt.Int64
		}
		list = append(list, item)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "codes": list})
}

func genCode() string {
	b := make([]byte, 16)
	for i := range b {
		b[i] = codeAlphabet[rand.Intn(len(codeAlphabet))]
	}
	return string(b[0:4]) + "-" + string(b[4:8]) + "-" + string(b[8:12]) + "-" + string(b[12:16])
}

func handleAdminCreate(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req struct {
		Days int    `json:"days"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		reply(w, false, "INVALID_INPUT", "请求格式错误", nil)
		return
	}
	var days sql.NullInt64
	if req.Days > 0 {
		days = sql.NullInt64{Int64: int64(req.Days), Valid: true}
	}
	if len(req.Note) > 200 {
		req.Note = req.Note[:200]
	}
	code := genCode()
	// phone 列保留兼容旧数据，新码不再绑定手机号
	_, err := db.Exec(`INSERT INTO codes (code, phone, duration_days, note, created_at) VALUES (?,?,?,?,?)`,
		code, "", nullableInt(days), req.Note, time.Now().Unix())
	if err != nil {
		reply(w, false, "DB", "写入失败", nil)
		return
	}
	reply(w, true, "", "生成成功", map[string]any{"code": code})
}

func handleAdminAction(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	// 路径：/admin/api/codes/{code}/{action} 或 /admin/api/codes/{code}（DELETE）
	rest := strings.TrimPrefix(r.URL.Path, "/admin/api/codes/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	code := strings.ToUpper(parts[0])
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	var res sql.Result
	var err error
	var doneMsg string
	switch {
	case r.Method == http.MethodDelete && action == "":
		res, err = db.Exec(`DELETE FROM codes WHERE code=?`, code)
		doneMsg = "已删除"
	case r.Method == http.MethodPost && action == "disable":
		res, err = db.Exec(`UPDATE codes SET status='disabled' WHERE code=?`, code)
		doneMsg = "已禁用"
	case r.Method == http.MethodPost && action == "enable":
		res, err = db.Exec(`UPDATE codes SET status='active' WHERE code=?`, code)
		doneMsg = "已启用"
	case r.Method == http.MethodPost && action == "unbind":
		res, err = db.Exec(`UPDATE codes SET device_id=NULL, device_name=NULL WHERE code=?`, code)
		doneMsg = "已解绑设备"
	default:
		reply(w, false, "NOT_FOUND", "未知操作", nil)
		return
	}
	if err != nil {
		reply(w, false, "DB", "操作失败", nil)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		reply(w, true, "", doneMsg, nil)
	} else {
		reply(w, false, "", "激活码不存在", nil)
	}
}

func main() {
	rand.Seed(time.Now().UnixNano())

	dbPath := os.Getenv("LICENSE_DB")
	if dbPath == "" {
		dbPath = "/opt/rauto-license/license.db"
	}
	var err error
	db, err = sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		log.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS codes (
		code TEXT PRIMARY KEY,
		phone TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active',
		duration_days INTEGER,
		note TEXT NOT NULL DEFAULT '',
		device_id TEXT,
		device_name TEXT,
		created_at INTEGER NOT NULL,
		activated_at INTEGER,
		expires_at INTEGER,
		last_verify_at INTEGER
	)`); err != nil {
		log.Fatal(err)
	}

	if adminPassword == "" {
		log.Println("[warn] ADMIN_PASSWORD 未设置，管理接口不可用")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/activate", handleActivate)
	mux.HandleFunc("POST /api/verify", handleVerify)
	mux.HandleFunc("POST /api/rebind", handleRebind)
	mux.HandleFunc("GET /admin/{$}", handleAdminPage)
	mux.HandleFunc("GET /admin/api/codes", handleAdminList)
	mux.HandleFunc("POST /admin/api/codes", handleAdminCreate)
	mux.HandleFunc("/admin/api/codes/", handleAdminAction)

	addr := "127.0.0.1:8811"
	log.Printf("rauto-license listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
