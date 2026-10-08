# statusline

一个 Claude Code mod（hooks 插件）：在输入框下方画一行会话状态——模型、思考强度、上下文占用、缓存命中率、项目、分支、git 改动。

```
 deepseek-flash[1m] · max · 9%/1.0M · 99% · HTML · main · +12 -3 ↑2
```

字段按上面的顺序排列，用灰色的 ` · ` 连接：

| 字段 | 颜色 | 说明 |
| --- | --- | --- |
| 模型 | 蓝 | `/model` 里显示的名字 |
| 思考强度 | 默认 | `low` … `max` |
| 上下文 | 绿 / 黄(≥70%) / 红(≥90%) | `占比/窗口大小`，如 `9%/1.0M` |
| 缓存命中率 | 默认 | 上次回复的输入 token 中命中缓存的比例 |
| 项目 | 蓝 | 会话根目录的最后一段 |
| 分支 | 蓝 | 当前分支（detached 时是 `detached@<oid>`） |
| git 改动 | 绿 `+N` / 红 `-N` / `↑N` | 新增行、删除行、待 push 的提交数；干净时显示绿色 `✓` |

没数据的字段自动省略；不在 git 仓库里时省略分支和 git 部分。原来的提示行（`? for shortcuts` 等）保留在它自己的位置，状态行画在下一行。

## 安装

在终端版 Claude Code 的输入框中输入：

```
/plugin install statusline --marketplace <owner>/<repo>
```

`y` 确认添加 marketplace，然后选 user 作用域（每个会话都生效）。装好后本会话立即生效，之后每个新会话自动加载。

## 不用 GitHub 的装法

把整个文件夹原样给对方，任选其一：

- 作为文件夹 marketplace 安装（长期、改源码后 `/reload-plugins` 即生效）：

  ```
  claude plugin marketplace add <文件夹路径> --scope user
  claude plugin install statusline@local-mods --scope user
  ```

- 单次会话试用：

  ```
  claude --plugin-dir <文件夹路径>
  ```

## 仓库结构

```
.claude-plugin/
  plugin.json        插件清单（name / version）
  marketplace.json   让本文件夹同时成为一个 marketplace
hooks/
  hooks.json         模块入口
  register.tsx        hook 注册：采集数据 + 绘制状态行
  util.ts            纯函数：解析 git 输出、格式化、拼装字段
types/index.d.ts     $.state 契约（claude plugin validate 按它校验状态键）
tests/statusline.test.ts
```

## 开发

- 校验：`claude plugin validate .`
- 测试：`claude plugin test .`（6 个用例：字段顺序/颜色、git 解析、无数据时让位给原提示行等）
- 以文件夹 marketplace 方式安装时，改完源码运行 `/reload-plugins` 即可，无需重装、无需改版本号。
- 发布新版本：把 `plugin.json` 的 `version` 加一后提交；使用者运行 `claude plugin update` 获取。

## 注意

- 需要支持 mod / hooks 的 Claude Code 版本（本插件在 2.1.293 上开发验证）。
- marketplace 的名字来自 `marketplace.json` 的 `name` 字段（当前是 `local-mods`），安装/更新里会引用它；改名后本地需要重新 add + install 一次。
