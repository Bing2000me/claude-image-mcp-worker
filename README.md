# claude-image-mcp-worker

一个部署在 Cloudflare Workers 上的生图 MCP 服务器：让 Claude 在 claude.ai 的聊天里调用 OpenAI 最新的 gpt-image 模型生图、改图，图片存在 R2，签名链接下载。单文件、无依赖、不需要 VPS。

Claude 本身不会画图，但它可以调用工具。只要给它接上一个生图用的 MCP 连接器，就能在 claude.ai 的对话里直接说“画一张……”，Claude 写好提示词、调用 OpenAI 的 gpt-image 模型，再把原图作为文件发到聊天里。

以前做这件事，要么自己掏钱买 API，要么在 VPS 上反代订阅，都有点折腾。现在 OpenAI 给 ChatGPT Pro 和 Business 订阅附带了每月的 API 额度，再加上 Cloudflare Workers 的免费套餐，整套方案**不需要 VPS，也基本不花额外的钱**，全程在网页后台点点鼠标就能搭好。

---

## 一、这套方案是怎么跑起来的

```
claude.ai 对话
   │  HTTPS + Authorization: Bearer <令牌>
   ▼
Cloudflare Worker（MCP 服务器）──►  OpenAI Images API（gpt-image 最新模型）
   │
   ▼
Cloudflare R2（存图片，7 天后自动清理）
   │
   ▼
带签名的下载链接 ──► Claude 下载原图，作为文件发进聊天
```

几个关键点：

- **MCP**（Model Context Protocol）是 Anthropic 提出的一套协议，让 AI 能调用外部工具。claude.ai 的“自定义连接器”就是填一个 MCP 服务器地址。
- 连接器是 **Anthropic 的服务器**去调用的，不是你的电脑在调，所以 MCP 必须挂在公网 HTTPS 上。这就是以前要 VPS 的原因。
- **Cloudflare Workers** 是无服务器函数：你只上传代码，Cloudflare 负责在它的机器上运行，不用自己维护服务器。免费套餐每天 10 万次请求，个人生图绰绰有余。
- **R2** 是 Cloudflare 的对象存储，用来存生成的图。GPT 图像模型只返回 base64，Worker 解码成图片存进 R2，再给 Claude 一个有时效的下载链接。

## 二、OpenAI 送的 API 额度

2026 年 10 月 28 日起，ChatGPT Pro 每月附带和套餐价等额的 API 额度（Pro $100 / $200 / $500 档分别送 $100 / $200 / $500），Business 按席位送。几个要注意的地方：

- **Plus 没有**这个福利。
- 付费订阅要满 7 天才能领；ChatGPT 账号和 API 组织要用**同一个邮箱**，而且都归你所有。
- 额度覆盖 Images API，生图可以用；但**每月到期清零，不能结转**。
- 在 ChatGPT 的 Settings → Billing 里领取并关联 API 组织。

生图模型（gpt-image 系列）需要先完成 API 的**组织验证**（Organization Verification，用证件做身份验证），建议领完额度马上去做。

费用参考：一张 1536×1024 的 medium 质量图大约用 1100 个输出 token，按 gpt-image-2 每百万输出 token $30 的价格算，**约 3 美分一张**。$100 的额度够画好几千张。

## 三、部署步骤

需要准备：符合条件的 ChatGPT 订阅、一个 Cloudflare 账号；最好还有一个托管在 Cloudflare 上的域名（没有的话用 Worker 自带的 workers.dev 地址也行）。

### 1. 在 OpenAI 后台准备 API key

1. 打开 platform.openai.com，确认 Settings → Organization → General 显示 **Verified**。
2. 新建一个项目（比如 `image-mcp`），专门给生图用。
3. 在项目里创建 API key，权限选 **Restricted**，只开两项：
   - **Model capabilities: Write**（`/v1/images` 归在这一组）
   - **Models: Read**（Worker 要靠它自动查最新模型）
4. 给项目设一个月度预算上限，不绑卡、不开自动充值。这样就算 key 泄露，损失也不会超过当月的赠送额度。

### 2. 生成两个随机密钥

在终端里运行两次：

```bash
openssl rand -hex 32
```

一个作为 `MCP_TOKEN`（连接器的访问令牌），另一个作为 `DOWNLOAD_SIGNING_KEY`（给下载链接签名用）。两个分开，下载链接里就不会带任何凭据。

### 3. 创建 R2 桶

Cloudflare 后台 → R2 Object Storage → Create bucket，名字随意（比如 `image-mcp`）。

建好后进桶的 Settings → **Object lifecycle rules**，加一条规则：对象创建 7 天后自动删除。旧图就会自动清理，不用写定时任务。

> 首次开通 R2 可能要求绑定支付方式，免费额度内不扣费。

### 4. 创建 Worker，粘贴代码

Workers & Pages → Create → 选 Hello World 模板，起个名字，点 Deploy。然后点 **Edit code**，删掉默认代码，把本仓库的 `worker.js` 整段粘进去，再点 Deploy。

### 5. 绑定 R2 和填密钥

在 Worker 的 Settings 里：

- **Bindings** → Add → R2 bucket，变量名必须填 `BUCKET`，选第 3 步建的桶。
  页面会提示“Update your Wrangler configuration”，网页部署不用管，关掉即可（那是给命令行部署的人看的）。
- **Variables and Secrets** → 添加三个 Secret：
  - `OPENAI_API_KEY`：第 1 步的 key
  - `MCP_TOKEN`：第 2 步生成的第一个
  - `DOWNLOAD_SIGNING_KEY`：第 2 步生成的第二个

可选的文本变量：

| 变量 | 作用 |
|---|---|
| `IMAGE_VARIANT` | 同一代模型里优先用哪个型号，默认 `sunburst`（画质优先），可改成 `flare`（速度优先） |
| `IMAGE_MODEL` | 固定某个模型；不填就自动用最新的 |
| `DOWNLOAD_TTL_HOURS` | 下载链接有效期，默认 72 |

### 6. 绑定自定义域名（推荐）

Settings → Domains & Routes → Add → Custom domain，比如 `img.example.com`。

浏览器打开 `https://img.example.com/`，看到 `image-official MCP is running.` 就说明部署成功了。

### 7. 在 claude.ai 添加连接器

设置 → 连接器 → 添加自定义连接器：

- **URL**：`https://img.example.com/mcp`
- **Authentication**：No sign-in
- **请求头**：名字 `Authorization`，值 `Bearer <你的 MCP_TOKEN>`（Bearer 后有一个空格）

保存后**开一个新对话**（工具列表只在对话开始时加载），对 Claude 说“生成一张图试试”就行。

## 四、它能做什么

Worker 提供 5 个工具：

| 工具 | 作用 | 消耗额度 |
|---|---|---|
| `generate_image` | 文字生图 | 是 |
| `edit_image` | 以一张或多张图为参考进行编辑 | 是 |
| `create_upload_url` | 生成一个上传链接，把你自己的图传上去当参考图 | 否 |
| `get_image` | 重新获取某张图的下载链接 | 否 |
| `list_models` | 查看当前能用哪些模型、默认用哪个 | 否 |

模型是**自动选最新的**：每次先查 `/v1/models`，挑版本号最高的 gpt-image 模型。目前选中的是 `gpt-image-2.6-sunburst`，以后出了新版本也会自动换过去，不用改代码。新模型新增的参数可以通过 `extra_params` 直接透传。

## 五、踩过的坑

1. **别把模型名写死。** 我第一版写死了 `gpt-image-2`，结果它已经落后两代了。现在改成运行时查询模型列表。
2. **连接器报 “Couldn't reach”，但服务器明明是好的。** claude.ai 添加连接器时会先探测要不要走 OAuth。如果你的 401 响应带了 `WWW-Authenticate` 头，或者 `/.well-known/oauth-protected-resource` 这类地址返回了 200，它就会以为要走 OAuth 然后失败。解决办法：401 不带这个头，未知路径一律返回 404。
3. **令牌放请求头，别放 URL。** 把令牌写进 URL 路径也能用，但截图、录屏、浏览器历史、访问日志里都会带出完整地址。放请求头里，令牌只存在连接器的私密设置中。
4. **base64 解码会不会超出 Workers 免费版的 CPU 限制？** 实测一张 3.3 MB 的 PNG 没有问题，等待 OpenAI 返回的时间不算 CPU 时间。真遇到超限，可以改用 jpeg/webp 输出，或者升级到每月 $5 的付费版。
5. **新加的连接器工具，旧对话里看不到。** 工具列表在对话开始时一次性加载，加完连接器要开新对话。

## 六、安全小结

- MCP 接口要求 `Authorization: Bearer` 鉴权，比较时用常量时间比较。
- 下载链接带 HMAC 签名和过期时间，签名密钥独立于 MCP 令牌；篡改或过期返回 403。
- 上传链接 15 分钟有效、只能成功上传一次、最大 20 MB。
- 图片 7 天后由 R2 生命周期规则自动删除。
- API key 只给生图相关的最小权限，项目设了预算上限。

## License

MIT
