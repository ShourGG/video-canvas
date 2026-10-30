# 接口说明

## 本机工作台接口

默认地址 `http://127.0.0.1:7790`。POST 使用 `Content-Type: application/json`。服务仅监听本机，校验 Host，不提供远程账户系统。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/canvas` | 视频画布 |
| GET | `/` | 经典视图和接口设置 |
| GET | `/api/state` | 角色、最新图片、脱敏配置 |
| POST | `/api/config` | 更新配置；空 Key 保留已保存的 Key |
| POST | `/api/characters` | 保存完整角色 / 场景数组 |
| GET | `/api/images?name=角色名` | 图片列表 |
| POST | `/api/generate` | 生成角色或场景图片，同步等待完成 |
| GET | `/api/shots` | 分镜列表，返回 `{"shots": [...]}` |
| POST | `/api/shots` | 保存单个分镜，传 `{"shot": {...}}` |
| POST | `/api/shots/preview` | 组装最终提示词，不请求生成接口 |
| GET / POST | `/api/canvas` | 读取或保存画布布局与版本选择 |
| GET | `/api/video/jobs` | 持久任务列表，返回 `{"jobs": [...]}` |
| POST | `/api/video/jobs` | 创建后台任务，返回 HTTP 202 |
| POST | `/api/video/jobs/{id}/pause` | 暂停本机查询 |
| POST | `/api/video/jobs/{id}/resume` | 续查原任务 |
| GET | `/img/{name}/{file}` | 读取角色或场景图片 |
| GET | `/video-media/{id}/{file}` | 首帧或视频，支持 Range |

创建任务：

```json
{
  "shot_id": "demo-01",
  "action": "both",
  "request_id": "a-unique-id-for-this-user-action"
}
```

`action` 为 `frame`、`video` 或 `both`。需要复用指定首帧时增加 `frame_job_id`，值为本机任务 ID。`video` 必须有首帧；`both` 优先复用已有首帧。同一次操作重试必须保留同一 `request_id`。已失败、已完成记录再次生成时使用新标识。

任务状态包括 `queued`、`running`、`waiting`、`paused`、`needs_review`、`completed`、`failed`。创建响应不确定时标记 `needs_review`，需要核对工作台并提交原上游 ID：

```json
{"task_id": "task_original_id_from_provider"}
```

角色数据通过 `kind: "scene"` 标识场景；分镜的 `characters` 和 `scenes` 是名称数组，均引用 `characters.json` 中的对象。可选 `portrait` 是对应图片目录中的文件名。

## 上游生成协议

设置中的 `base_url` 应包含 `/v1`，例如 `https://api.example.com/v1`。请求使用 `Authorization: Bearer YOUR_API_KEY`。以下是本应用依赖的 Muse 任务协议，不代表所有图片 / 视频提供商都实现了相同路径和字段。

### 创建图片任务

`POST {base_url}/images/tasks`

```json
{
  "model": "muse-image",
  "prompt": "以人物参考图为身份锚点，旅人站在驿站门外，写实摄影，无文字",
  "size": "16:9",
  "n": 1,
  "response_format": "url",
  "timeout": 600,
  "images": ["data:image/png;base64,BASE64_IMAGE_DATA"]
}
```

参考图可省略。查询：`GET {base_url}/images/tasks/{task_id}`。

### 创建视频任务

`POST {base_url}/videos`

```json
{
  "model": "muse-video",
  "prompt": "以首帧为起点，旅人放下行囊，轻声说话，固定机位，无字幕",
  "duration": 5,
  "size": "16:9",
  "image": "data:image/png;base64,BASE64_FIRST_FRAME",
  "timeout": 900
}
```

查询：`GET {base_url}/videos/{task_id}`。任务创建时附带 `Idempotency-Key`；能否在提供商侧实现幂等由其服务决定，本应用不会仅据此自动重提创建请求。

### 返回值

创建响应必须包含 `id` 或 `task_id`：

```json
{"id": "task_example", "status": "queued", "progress": 0}
```

生成成功：

```json
{
  "id": "task_example",
  "status": "completed",
  "progress": 100,
  "result": {"url": "/v1/media/example.mp4"}
}
```

成功状态支持 `completed` / `succeeded`，失败支持 `failed` / `error` / `cancelled` / `canceled`。媒体地址可以是相对路径或绝对 URL；仅同源媒体下载携带 API 鉴权。当前结果下载支持图片与 MP4，不解析远程 HLS 播放列表。

视频任务查询遇到 429、网络失败或 5xx 时会退避，最长间隔 60 秒；查询一轮最多 30 分钟，然后保留 ID 并暂停。图片候选生成使用同步等待接口，长时间断开时应先核对上游任务，不要直接重复提交。
