# 任务预算 · dsh-plugin-task-budget

> **一轮一价，到线即停。**
>
> 给 DeepSeek Harness 的每一轮对话设一个人民币花费上限，默认 **5 元**。到上限就在下一个模型请求发出之前停住，不让这一轮继续扣钱。开关和金额在输入框下方状态栏最右侧，一眼能看到本轮花了多少。
>
> A CNY spending cap for each DeepSeek Harness turn — ¥5 by default. The run stops before the next model request once the cap is reached; the switch and the running total sit at the right end of the composer dock.

输入框下方状态栏**最右侧**就是它（不写标签、不带图标，字体颜色跟随同一行其他条目）：

```
                     ... 这一行其他条目 ...    (开关) ¥0.32/5.00
```

- 点**开关** → 立即开 / 关限额；打开时轨道为深灰，关闭时浅灰。
- 点**金额** → 就地展开输入框，改上限后「保存」或回车；Esc 取消。
- 超限时金额变红，本轮已被自动停止；调高上限或关掉开关后，下一条消息照常。

## 安装

**插件市场 / 插件页**：搜索 `task budget`（或 `dsh-plugin-task-budget`）→ 安装 → 刷新页面。

**GitHub 直接装**：

```sh
dsh plugin --profile <profile> add github:i1537725423-dotcom/dsh-plugin-task-budget
```

**npm**（发布后）：

```sh
dsh plugin --profile <profile> add dsh-plugin-task-budget
```

装完刷新一次页面。不需要重启 App。

## 它怎么算「花了多少钱」

按每轮累计的 `assistant/message.usage`（token 数）× DeepSeek 官方价目表折算人民币：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| `deepseek-v4-pro` | 0.30 / 0.15 | 9 / 4.5 | 27 / 13.5 |

单位：元 / 百万 tokens；每格「高峰 / 空闲」。**高峰** = 北京时间周一至周五 9:00–12:00、14:00–18:00，其余（含周末）为空闲。

口径与限制：

- 这是**按 token 的估算**，不是平台出账数字；DeepSeek 的 Search / Fetch 按次计费、以及价目表之外的费用不计入。
- 法定节假日未内置，仍按工作日高峰价计 —— 只会高估，不会低估。
- 压缩、生成标题这类内部模型调用**记账但不拦**（拦了会把会话弄坏），所以极端情况下会略微超过上限。
- 一轮里最后那个请求发出时还没超限、跑完才超的情况，会允许跑完，下一步前再停。

## 拦截点

1. `agent/pre-step`：下一步进入前，若本轮已花 ≥ 上限 → 直接拒绝（干净停止，不产生报错）。
2. `llm/stream`：所有模型请求的必经之路，再兜一道。万一 pre-step 没拦住（例如压缩触发），这里抛出
   `已达本轮花费上限 ¥5.00（本轮已花 ¥5.12），已自动停止……`，请求不会发出去。

## 配置

`cordis.patch.yml` 里该行的 `config` 只是**出厂默认值**；界面上改过的值写在状态文件里，优先于 config。

```yaml
- insert:
    - id: task-budget
      name: 'dsh-plugin-task-budget'
      config:
        enabled: true     # 默认开
        limitCny: 5       # 默认 5 元
        rates:            # 可选：覆盖某个模型的单价（元/百万 tokens，[高峰, 空闲]）
          deepseek-flash: { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] }
        # stateFile / diagFile / diag 一般不用写，默认落在 $DSH_HOME/task-budget/
```

`enabled` / `limitCny` 也可以直接用本机接口改：

```bash
curl -s -H 'x-dsh-task-budget: 1' \
  'http://127.0.0.1:<端口>/task-budget/state?session=<会话id>'
curl -s -H 'x-dsh-task-budget: 1' -H 'content-type: application/json' \
  -d '{"enabled":true,"limitCny":3}' \
  'http://127.0.0.1:<端口>/task-budget/config'
```

另有 `GET /task-budget/status` 看所有在记的会话。

## 数据放在哪

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/task-budget/state.json` | 界面改过的开关与上限；删掉即回出厂默认 |
| `$DSH_HOME/task-budget/diag.log` | 诊断日志：挂到哪个 webServer、收到哪些非轮询请求 |

不写插件包目录（从 npm 装时那是 `node_modules`，升级会丢）。插件不向外发任何请求，也没有遥测；接口只监听本机回环地址，且要求自定义请求头 `x-dsh-task-budget: 1`。

## 排查

**症状：控件显示出来了，但开关是灰的、点不动。**
几乎都是客户端拿不到 `/task-budget/state`：Host 半的记账/拦截还活着，只是本机接口没挂上。插件会每 2 秒核对 `webServer` 并补挂，用 `ctx.effect` 注册（插件重载时自动注销，不留同路径注册）；`state.json` 是唯一真源，每个实例每 2 秒对齐一次。

```bash
curl -s -H 'x-dsh-task-budget: 1' http://127.0.0.1:<端口>/task-budget/state   # 200 且有 state 即接口正常
tail -5 "$DSH_HOME/task-budget/diag.log"                                      # 挂载/同步记录
```

## 开发

```sh
# 本地自测：假 ctx + 假 HTTP，不启动 DSH
node --experimental-strip-types test-local.mjs   # 或直接用本机 node 跑
node test-local.mjs

# 装到本机 profile 调试
dsh plugin --profile <profile> add link:$(pwd)
```

`index.js` 是 Host 半（记账/拦截/接口），`client.js` 是浏览器半（那枚控件），`cordis.patch.yml` 插入插件行并入出厂默认值。

## License

MIT © 2026 liuzhixian
