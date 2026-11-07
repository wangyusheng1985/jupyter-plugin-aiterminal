# 实施证据与激活说明

## 基线与能力核对

- 实施基线提交：`8a904f55458bfa2d2d9e630a151d03faca18f55e`。当前工作树包含尚未归档的 `shared-dsh-detached-sessions` 实现（共享 runtime、注册表、脱机文档落盘及其测试），本变更保留这些未提交改动；不执行 reset/clean。若该变更先落地，先以它为基线 rebase，再验证本变更，不覆盖其实现。
- 远程只读包元数据核对：`deepseek-harness-runtime-bin==0.2.1rc2`，与项目版本门禁一致。本地 Python 环境没有安装该包。
- 本地 DSH checkout 为 `0.2.2-alpha.2`；探针对 `dsh-v0.2.1-rc.2` tag 的 `packages/compaction/compaction-basic/src/config.ts` 与本地文件逐字节比对一致。预算公式与加载期不变量据此核对，定义注释位于 `dsh_config.py` 的唯一预算算术函数。
- ACP `session/new`/`resume` 配置边界：插件只传 `cwd`/`mcpServers`，预算与压缩配置来自共享进程启动时的 profile patch，不能在新建会话时热改。
- ACP 没有压缩专用事件；仅有 `usage_update` 等会话更新，因此启用时只报告 `not-observable`，不凭 token 用量变化声称发生压缩。
- `settings.py` 将 raw 设置传给 parser，无须修改读取路径。

## 受控配置探针（无模型请求）

探针在临时 HOME/DSH_HOME 下运行 `--profile acp --dump-config`，临时 overlay 随后清理；没有改现有 runtime patch，没有重启服务或调用模型。

- pinned 二进制存在行 `token-meter` 与 `compaction-basic`。
- `compaction-basic` 的 `auto`、`thresholdRatio`、`headroomTokens`、`retainRatio`、`maxTokens` 可合成到对应行。
- `token-meter` 不接受任何 config 字段，因此保留启用，不给它写参数。
- 不存在行的 patch 可能返回退出码 0，但 stderr 含 `patch: entry "<id>" not found`；预检必须检查警告而非仅退出码。
- `--dump-config` 不做插件 schema 校验，拼错字段也能合成。它只能证明已知字段和值落入配置，不能代替字段定义核对或声称完成通用 schema 校验。

## 管理员激活待生效配置

1. 在 Settings → AI Terminal 保存预算与压缩设置。已连接工作区请求配置报告；核对 desired 与 active、来源及 `pending-next-runtime`。未连接工作区不会为了刷新报告自动连接。
2. 正在运行的共享 runtime 不受保存设置影响；新建会话与重连仍使用原 active 配置。插件不自动重启、替换 runtime 或中断运行/脱机任务。
3. 管理员确认所有任务已结束并安排维护窗口后，才可显式重启 Jupyter 服务。重启是管理员操作，不是保存设置或插件自动行为。本地实现阶段未执行；后续用户明确授权部署后已执行一次维护重启，详见下方部署记录。
4. 服务下次启动并首次初始化共享 runtime 后，核对 active 与 desired 一致、预检通过、runtime lifetime/generation 对应新实例。generation 只在同一 host lifetime 内递增，不承诺跨服务器重启持久递增。
5. 压缩仍可能不可观测；配置生效不等于已观测到压缩。调大输出预算不保证修复网关/供应商截断。

## 尚待验收

- 部署已获用户授权并完成；任务 8.1 暂保留未完成，等待生产按需共享 runtime 的零 prompt 首启观测，隔离验证不能替代这一项。
- 最终验证：`python3 -m pytest -q --tb=short` → **475 passed, 6 skipped**；`npx jest --runInBand --no-coverage` → **24 suites / 505 tests passed**；`npx tsc --noEmit`、`openspec validate configure-model-budgets-and-compaction --strict` 与 `git diff --check` 均通过。
- `jlpm install --immutable` 与 `jlpm build:prod` 均通过。安装仍有 peer dependency 警告；本机 Python 有 `_distutils_hack` 的 site `.pth` 环境警告。未升级其他依赖或修改 Python 环境。
- 独立交叉审查已确认并发首启锁、配置报告安全、非致命刷新、终态提示及脱机 reason 接线无 P0/P1；最后补测已复审通过（OK with notes），确认任务 6.5 / 6.6 / 7.2 的断言有效且不将 usage 模拟称为真实压缩观测。
- 本地阶段没有执行远程安装或重启；后续用户授权后的部署记录如下。全程没有发送真实模型请求，不能据此证明网关/供应商截断已解决。

## 已授权部署记录

- 目标：`10.9.34.84:8888`，`jupyter.service`。确认旧会话日志最后为 `turn/end: max-tokens`、目标文档无运行标记、shell 无活动子任务后维护重启。
- wheel：`jupyter_aiterminal-0.8.1-py3-none-any.whl`，158059 字节；SHA256 `0799ff8bf8787d7b6b0968c9354dde8145054f3dbf083c0cf225f032d1126b9b`，本地与远程一致。服务主 PID 从 `835262` 更新为 `1303284`，服务 active，`/login` 200、`/lab` 302。
- 旧安装备份：`/root/aiterminal-backup-20261103-200732`；部署目录：`/root/aiterminal-deploy-20261103`。未修改用户模型设置或凭证。
- 真实设置的安全报告：C=128000(user)、O=8192(user)、auto=true、thresholdRatio=0.8、retainRatio=0.16、headroom=29952、summary=8192；messageBudget=119808、pressure=89856、threshold=89856、retain=19169。
- boot-free dump 内容确认 provider 的 contextWindow/maxTokens/defaultMaxTokens 为 128000/8192/8192，且无 patch 告警；压缩已知行预检通过。`preflightApplied` 仅证明 token-meter/compaction-basic 已知字段匹配，provider C/O 的额外证据来自本次 dump 观察，非该标记本身。
- 隔离真实 pinned runtime 零 prompt 验证：active、generation=1、differences=0、preflightApplied=true、初始化一次、两个不同 session。临时进程与缓存已清理。此证据不冒充生产共享进程已首启。
- 4096 fallback 常量仍为缺省设置的文档化默认值，不再是夹取上限。压缩状态仍为 not-observable。

## 回滚说明（仅文档，未执行）

原部署报告中的 `cp -a` 合并/嵌套写法不可直接使用。实际回滚必须先在维护窗口确认无运行任务，检查三份备份均完整，再停服，将以下三个现有目标目录移到独立回滚隔离目录（不覆盖/合并），按准确目标名复制备份，然后核对文件哈希与目录结构再启动：

| 备份目录名 | 准确恢复目标 |
| --- | --- |
| `jupyter_aiterminal` | `/root/anaconda3/lib/python3.10/site-packages/jupyter_aiterminal` |
| `jupyter_aiterminal-0.8.1.dist-info` | `/root/anaconda3/lib/python3.10/site-packages/jupyter_aiterminal-0.8.1.dist-info` |
| `jupyter-aiterminal-labextension` | `/root/anaconda3/share/jupyter/labextensions/jupyter-aiterminal` |

复制时准确目标必须不存在，避免 `cp -a source existing-target` 产生嵌套或混装；保留隔离的新版本供恢复。核对 Jupyter server extension 注册文件未变更，再启动并检查 HTTP/扩展加载。回滚亦需单独授权，不由插件或本次验收自动执行。
