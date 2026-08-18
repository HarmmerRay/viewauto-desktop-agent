# 微信二创版：上游同步与 Patch 维护

本二创版本保留 SightFlow 的核心“看 → 想 → 做 → 记录”链路，只开放微信，并新增两阶段的“添加微信好友”操作。

> 当前工作目录不包含 `.git` 元数据，因此这里不能安全地伪造提交历史，也不能直接执行 `git pull`、`rebase` 或生成可靠补丁。请在你自己的 Fork 正式 Git 克隆中应用这些改动。

## 1. 推荐的仓库结构

- `origin`：你自己的 Fork，用于保存微信二创版本。
- `upstream`：SightFlow 原始仓库，只用于拉取核心能力更新。
- `main`：尽量跟随 `upstream/main`，不要直接堆积二创代码。
- `wechat-product`：你的产品分支，保存微信专用改动。

首次配置：

```powershell
git clone <你的 Fork URL> sightflow-wechat-agent
cd sightflow-wechat-agent
git remote add upstream https://github.com/sightflow-dev/sightflow-desktop-agent.git
git fetch --all --prune
git switch -c wechat-product origin/main
```

检查远端：

```powershell
git remote -v
```

## 2. 二创代码要以“小提交”保存

不要把全部变化压成一个长期维护的大补丁。建议按职责拆成以下提交：

1. `fix(provider): allow independent reply provider config`
2. `fix(capture): capture native WeChat window and fall back safely`
3. `feat(wechat-only): restrict UI and runtime to WeChat`
4. `feat(friend): add two-stage WeChat friend request automation`
5. `feat(trace): record friend operation observe-think-act-verify steps`
6. `feat(ui): add friend operation form and explicit confirmation`

这样上游改动发生冲突时，可以逐个提交定位和解决，而不是反复维护一份无法审查的大型 diff。

## 3. 拉取上游核心代码

在工作区干净时执行：

```powershell
git switch main
git fetch upstream
git reset --hard upstream/main
git push origin main --force-with-lease
```

然后把产品分支重放到新上游：

```powershell
git switch wechat-product
git rebase main
```

如果不希望重写产品分支历史，也可以使用：

```powershell
git merge main
```

长期二创更推荐 `rebase`，因为二创提交会持续位于上游提交之后，结构更接近“Pull 核心 + 依次应用产品 Patch”。

## 4. 冲突处理原则

优先保留上游的核心实现，再恢复微信产品约束：

- **看**：保留上游截图/VLM 改进，同时保留微信窗口精确捕获和白屏回退。
- **想**：保留上游模型调用改进，同时确保视觉模型与回复模型配置相互独立。
- **做**：保留上游 RPA 原子能力，同时保留拟人移动、点击和输入。
- **记录**：保留 Trace/工作记忆格式，新增动作类型时尽量只扩展联合类型。
- **UI**：上游新增平台可以留在底层类型中，但微信二创 UI 和运行时入口必须继续强制归一化为 `wechat`。
- **外部发送**：添加好友必须继续保持 `prepare` / `confirm` 两阶段，不得在准备阶段点击最终发送。

解决每个冲突后：

```powershell
git add <已解决的文件>
git rebase --continue
npm.cmd run typecheck
npm.cmd run build
```

## 5. 导出和应用 Patch

需要备份、审查或迁移二创提交时，可以导出标准 Git Patch：

```powershell
New-Item -ItemType Directory -Force patches | Out-Null
git format-patch main..wechat-product -o patches
```

在另一个基于同一上游版本的克隆中应用：

```powershell
git am patches/*.patch
```

遇到冲突：

```powershell
git status
# 修复文件后
git add <文件>
git am --continue
```

放弃本次应用：

```powershell
git am --abort
```

> 不要用 `patch-package` 管理本项目自身二创代码。`patch-package` 适合修补 `node_modules` 依赖，而不是维护你的产品分支。

## 6. 每次同步后的验证清单

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run build
npm.cmd run dev:test-screenshot
npm.cmd start
```

人工检查：

1. 主界面只显示微信。
2. 设置里视觉模型和回复模型的 API Key、Base URL、模型名称可以独立保存。
3. 微信窗口截图不是白屏。
4. 消息监控与添加好友不能同时执行。
5. 好友操作准备完成后停在发送前。
6. 确认发送时重新截图、重新定位，不复用旧坐标。
7. 工作记忆中能看到 observe / think / act / verify 和截图。
8. 未经明确人工确认，不进行真实外部发送。
