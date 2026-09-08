# 接入指南 · [sshzyu.com](http://sshzyu.com)

## 1. Quick Start

### 配置


| 参数          | 值                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------- |
| Base URL    | `https://sshzyu.com/v1`                                                                   |
| API Key     | [控制台「API 密钥」](https://sshzyu.com/keys)页创建                                                 |
| 认证头         | `Authorization: Bearer YOUR_API_KEY`                                                      |
| 对话接口        | `POST https://sshzyu.com/v1/chat/completions`                                             |
| GPT 图片接口    | `POST https://sshzyu.com/v1/images/generations`、`POST https://sshzyu.com/v1/images/edits` |
| Gemini 图片接口 | `POST https://sshzyu.com/v1beta/models/{model}:generateContent`                           |


API Key 创建后只显示一次，请保存到服务端环境变量。不要写入前端页面、公开仓库或日志。

### 发起对话请求

所有对话模型都兼容 OpenAI Chat Completions 格式。把 `YOUR_MODEL` 换成下表中的模型 ID：

```bash
curl https://sshzyu.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

返回的 JSON 里 `choices[0].message.content` 是模型回复。需要流式返回时，加入 `"stream": true`。

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://sshzyu.com/v1",
)
response = client.chat.completions.create(
    model="gpt-5.6-sol",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### 可用模型

模型 ID 以控制台当前开通为准。


| 类型      | 模型名称                                  | `model`                        | 能力              |
| ------- | ------------------------------------- | ------------------------------ | --------------- |
| 对话      | GPT-5.6 Sol                           | `gpt-5.6-sol`                  | GPT-5.6 Sol     |
| 对话      | GPT-5.6 Terra                         | `gpt-5.6-terra`                | GPT-5.6 Terra   |
| 对话      | GPT-5.6 Luna                          | `gpt-5.6-luna`                 | GPT-5.6 Luna    |
| 对话      | GPT-5.5                               | `gpt-5.5`                      | GPT-5.5         |
| 对话      | DeepSeek-V4-Flash                     | `deepseek-v4-flash`            | 文本对话            |
| 对话      | DeepSeek-V4-Flash-Vision-Exp          | `deepseek-v4-flash-vision-exp` | 文本对话、图片输入（实验模型） |
| 对话      | Xiaomi MiMo-V2.5                      | `mimo-v2.5`                    | 文本生成、全模态理解      |
| 生图 / 编辑 | GPT Image 2                           | `gpt-image-2`                  | 文生图、图片编辑        |
| 生图 / 编辑 | Nano Banana 2（Gemini 3.1 Flash Image） | `gemini-3.1-flash-image`       | 图片生成、图片编辑       |


### 请求地址

所有请求均使用本站地址和本站 API Key。


| 模型 / 用途                                  | 请求地址                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| GPT-5.6、GPT-5.5、DeepSeek-V4、MiMo-V2.5 对话 | `POST https://sshzyu.com/v1/chat/completions`                                  |
| GPT Image 2 生图                           | `POST https://sshzyu.com/v1/images/generations`                                |
| GPT Image 2 编辑                           | `POST https://sshzyu.com/v1/images/edits`                                      |
| Nano Banana 2 生图 / 编辑                    | `POST https://sshzyu.com/v1beta/models/gemini-3.1-flash-image:generateContent` |


Gemini 原生接口不使用 OpenAI `messages` 字段，按 Gemini API 的 `contents` / `parts` 格式提交。示例：

```bash
curl https://sshzyu.com/v1beta/models/gemini-3.1-flash-image:generateContent \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [{"text": "生成一张简洁的产品宣传图"}]
    }],
    "generationConfig": {"responseModalities": ["IMAGE"]}
  }'
```

### 多轮对话

把上一轮模型回复作为 `role: "assistant"` 的消息加入 `messages`，再追加新的用户消息。

```json
"messages": [
  {"role": "user", "content": "你好"},
  {"role": "assistant", "content": "你好，有什么可以帮你？"},
  {"role": "user", "content": "介绍一下你自己"}
]
```

### 常用参数


| 参数            | 说明                          |
| ------------- | --------------------------- |
| `model`       | 必填，模型 ID，以控制台开通情况为准         |
| `messages`    | 对话接口必填，消息列表                 |
| `stream`      | 默认 `false`；设为 `true` 返回流式结果 |
| `temperature` | 可选，控制输出随机性                  |
| `max_tokens`  | 可选，限制单次回复长度                 |


## 2. 客户端接入

本节讲如何把控制台创建好的 API 接入到常用客户端。前置：先在 [API 密钥](/keys) 页创建好一把密钥（见 Quick Start）。

### 2.1 接入 Claude Code / Codex

[CC Switch](https://cc-switch.com) 是一个管理 Claude Code、Codex 等多个客户端供应商配置的切换工具。本站支持一键导入，地址和密钥会自动填好。

**方式一：一键导入（推荐）**

1. 登录 [控制台](https://sshzyu.com)，打开 [API 密钥](/keys)。
2. 找到要用的密钥，点「导入 CC Switch」。
3. 浏览器唤起 CC Switch，自动填入 Base URL 和 API Key，确认即可。
4. 在 CC Switch 切换到该供应商，重启 Claude Code / Codex。

> 若浏览器没有唤起，说明未安装 CC Switch，安装后重试。

![控制台「导入 CC Switch」按钮](iamge/站点内一键导入css-1.png)

![CC Switch 确认导入配置](iamge/站点内一键导入css-2.png)

**方式二：手动添加**

1. 打开 CC Switch →「供应商」→「新增供应商」。
2. 选择要接入的客户端（Claude Code / Codex）。
3. 按下表填写后保存。
4. 切换到该供应商，并重启客户端。


| 项                | 值                    |
| ---------------- | -------------------- |
| 名称               | sshzyu               |
| 客户端              | Claude Code / Codex  |
| API 地址（Base URL） | `https://sshzyu.com` |
| API Key          | 控制台「API 密钥」创建        |
| 模型（Codex 选填）     | `gpt-5.5`            |


> 手动填写的地址以「一键导入」自动带出的为准；不同客户端的协议路径由 CC Switch 自动补齐。

![CC Switch 新增供应商](iamge/ccs自定义-1.png)

![CC Switch 保存后的供应商配置](iamge/ccs自定义-2.png)

### 2.2 接入 NewMax 客户端

[NewMax](https://newmax.cc/download) 是一款本地优先的桌面 AI Agent 客户端，支持添加自定义提供商（OpenAI、Claude、DeepSeek 等 15+）。本站兼容 OpenAI 接口，可直接接入。

**方式一：手动添加**

1. 打开 NewMax，点击侧栏底部头像 →「设置」。
2. 点左侧「模型」→「添加提供商」。
3. 供应商类型选 OpenAI（兼容）。
4. 按下表填写后点「测试连接」验证，再保存。
5. 回到对话，在右上角模型选择器里选本站模型（如 `gpt-5.6-sol`）。


| 项        | 值                                                         |
| -------- | --------------------------------------------------------- |
| 供应商类型    | OpenAI（兼容）                                                |
| Base URL | `https://sshzyu.com`                                      |
| API Key  | 控制台「API 密钥」创建                                             |
| 可选模型     | `gpt-5.6-sol`、`gpt-5.5`、`deepseek-v4-flash`、`mimo-v2.5` 等 |


![NewMax 添加提供商并测试连接](iamge/newmax导入-1.png)
![NewMax 从 CC Switch 导入供应商](iamge/newmax导入-2.png)

**方式二：从 CC Switch 导入**

已在 CC Switch 加过本站时，可直接导入：

1. 设置 → 模型 →「添加模型」。
2. 供应商目录点「从 CC Switch 导入」。
3. 勾选本站供应商（CC Switch 用了自定义数据目录时，点「选择数据库文件」选 `cc-switch.db`）。
4. 点「导入」，NewMax 会自动带入 Base URL、API Key 和模型列表。



## 3. 错误码

请求失败时，本站会返回 HTTP 状态码和错误信息。OpenAI 兼容接口通常返回：

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "model is required"
  }
}
```

Gemini 原生接口返回：

```json
{
  "error": {
    "code": 400,
    "message": "Invalid request",
    "status": "INVALID_ARGUMENT"
  }
}
```

### CODE / DESCRIPTION


| CODE  | DESCRIPTION          | Cause                  | Solution                         |
| ----- | -------------------- | ---------------------- | -------------------------------- |
| `400` | Invalid Format       | 请求体格式错误，或缺少必填字段        | 按 `error.message` 修改请求体          |
| `401` | Authentication Fails | API Key 无效、缺失或鉴权失败     | 检查 API Key、`Bearer` 前缀和请求地址      |
| `402` | Insufficient Balance | 账户余额不足                 | 到控制台充值后重试                        |
| `403` | Permission Denied    | API Key 所属分组无权访问该模型或接口 | 检查分组权限、模型权限和接口类型                 |
| `404` | Not Found            | 路径、模型或异步任务不存在          | 检查 URL、模型 ID；查询任务时使用提交任务的同一把 Key |
| `422` | Invalid Parameters   | 参数值不合法，或当前模型不支持该参数     | 按 `error.message` 修改参数           |
| `429` | Rate Limit Reached   | 请求频率、并发数或等待队列达到上限      | 降低请求频率，使用指数退避后重试                 |
| `500` | Server Error         | 服务端内部错误                | 稍后重试；持续失败时提供请求 ID                |
| `502` | Bad Gateway          | 上游模型服务返回异常             | 稍后重试；持续失败时提供请求 ID                |
| `503` | Server Overloaded    | 服务或可用模型账户暂时繁忙          | 稍后重试，或换用其它已开通模型                  |


### 排查顺序

1. 检查请求地址、请求方法和 `Authorization` 请求头。
2. 检查 `model` 是否为控制台当前开通的模型 ID。
3. 检查请求体格式、必填参数和接口类型是否匹配。
4. 检查余额、频率、并发和分组权限。
5. 仍然失败时，记录 HTTP 状态码、错误消息和请求 ID，联系管理员。

## 4. 联系方式

需要技术支持或反馈，请联系管理员。

![交流群](iamge/交流群.jpg)