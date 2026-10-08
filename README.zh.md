# @chi-hong22/dsh-plan-spend

DSH 用量弹窗插件：在 Web GUI 的全局浮层里放一个「用量」按钮，点开显示**已配置服务商**的套餐花销。

## 展示内容

| 服务商 | 数据源 | 展示 |
|---|---|---|
| DeepSeek 官方 | `GET https://api.deepseek.com/user/balance` | 充值与赠送钱包的总余额（保留服务端精度）、余额是否充足 |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 5 小时 / 7 天 / 每月三个窗口的已用百分比、进度条、重置倒计时 |

**已知限制**：OpenCode Go 的用量接口只返回百分比与重置时间，**不返回已用/上限金额**。所以弹窗里 OpenCode 一栏只有百分比，没有「还剩多少美元」。确切金额只在 OpenCode 控制台可见。

## 安装

```sh
dsh plugin --profile <profile> add github:Chi-hong22/dsh-plan-spend
```

> `desktop` profile 由 Electron 应用独占管理，命令行 `dsh plugin --profile desktop add` 会报
> `profile "desktop" is managed exclusively by the Electron application`；请改用 GUI 的插件页安装。

验证挂载：

```sh
dsh --profile <profile> --dump-config | grep usage-meter
```

## 配置

插件没有配置项。它按凭据是否配置来决定展示哪些服务商，凭据名写在 `index.js` 的 `ADAPTERS` 表里：

| 服务商 | 凭据 ref（POSIX 环境变量名） |
|---|---|
| DeepSeek 官方 | `DEEPSEEK_API_KEY` |
| OpenCode Go | `OPENCODEGO_API_KEY` |

凭据通过 `ctx.credentials.resolve()` 解析，来源优先级见
`@deepseek-ai/dsh-credentials-local`（启动环境 → 存储文件 → 项目 `.env` → harness home `.env`）。
**未配置的服务商不会发起请求**，会显示为「未配置凭据，已跳过」。

新增服务商 = 在 `ADAPTERS` 里加一行 + 写一个 reader 函数。

## 界面位置与尺寸

插件注册两条座位：

- **`sidebar.footer.action`**（id `usage-meter`）：触发按钮。该座位是侧边栏自己的操作行，会向下发
  `{ wide }`，所以按钮随侧边栏收起/展开自动联动（`wide === false` 时只留圆点图标）。
- **`shell.overlay`**（id `usage-meter`）：面板。全局浮层位于每一列之外，面板因此能落在侧边栏
  **外侧**，而不会被侧边栏的 `overflow: hidden` 裁掉。

**面板定位**：面板测量按钮所在的**框架级列**（结构性上溯到 frame 的直接子元素，不依赖哈希类名），
左边缘锚在该列右缘 + 10px，底边锚在按钮底边，再向上生长；侧边栏宽度变化时重新测量。

> 一处偏差需要你知道：`sidebar.settings`（账户行）是 **single** 座位，已被 shell 的账户/设置 UI
> 占用，占它等于遮蔽官方 UI（`replaceRisk: shadows-shipped-ui`）。而 `.footArea` 是 column，`footerActions`
> 在 `settingsArea` 之上——所以按钮落在账户行的**上一行**，不是同一行账户的右侧。

**按钮样式**：度量取自官方账户行（`AccountMenu`）——`padding: 6px`、`border-radius: 12px`、
`gap: 8px`、`font-size: 14px/22px`、行外边距 `4px -2px`，hover 用
`--dsw-alias-interactive-bg-hover`；图标 **32×32**，与账户头像同尺寸；轨道态为 `40×40` 居中图标。

**与账户行对齐（测量而非写死）**：挂载后取相邻的账户行，在其中找第一个 `button`，再取它第一个
有宽度的子元素（头像）与其后第一个有宽度的兄弟（文字），把两者左边缘换算成本行的 `padding-left`
与文字 `margin-left`。因此账户行的实际缩进是多少，本行都跟随；找不到账户行时退回 CSS 默认值。
轨道态不参与对齐，保持自身居中盒。

**关闭方式**：再次点击按钮、点面板里的 `×`、按 `Esc`、或点击面板外任意位置，都会关闭。

**缩放**：手柄在面板**右上角**（离按钮最远的那个角），向右拖增宽、向上拖增高；尺寸存
`localStorage: usage-meter.size`，并受面板最小尺寸与浮层边界双重约束。

想恢复默认尺寸，清掉 `usage-meter.size`。改完源码运行 `npm run build` 重新生成 `client.js`；
`client.js` 是构建产物，不要直接编辑。

> 浏览器侧要拿到新 `client.js` 需要**刷新页面**：DSH 的 bundle 替换不属于普通启停同步。

## 客户端半包必须导出 inject

`client.body.js` 返回的插件对象带 `inject: ['slots', 'locale']`，Cordis 才会等到这两个服务就绪后再
`apply`。若不声明，`ctx.get('locale')` 可能拿到 `undefined`，`t` 会**静默退化成「原样返回键」**，
界面上出现 `button.label`、`panel.title`、`window.rolling` 这类原始键——而数据与布局完全正常，
只有文案坏掉，极易误判成其它问题。官方客户端半包（如 `dsh-client-ui-sidebar`、
`dsh-client-ui-cordis`）都导出了 `inject`，照做即可。
## 安全边界

- API 密钥只在 Host 半包内使用，**不下发到浏览器**；浏览器只读同源 JSON。
- `GET /usage-meter/snapshot` 走 harness web server 的命名路由，**没有额外鉴权**。当 web server
  绑定 `0.0.0.0` 时，同一局域网内可读到余额与用量数字（不含密钥）。仅在本机使用时无影响。

## 结构

```
index.js              Host 半包：凭据解析 + 两个上游接口 + 30s 缓存 + 路由
client.body.js        Client 半包源码（裸函数体，无 import/JSX）
client.js             构建产物（scripts/build-client.mjs 生成）
cordis.patch.yml      bundle patch：向 profile 插入一行
scripts/build-client.mjs
scripts/probe-sources.ps1   一次性探针：不开插件直接验证两个上游接口
tests/client-ui.test.mjs    触发器/定位/缩放行为测试（npm test）
```

## License

MIT
