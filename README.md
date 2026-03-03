# WebRTC Meeting - 在线音视频会议平台

一个基于 WebRTC 技术的现代化在线音视频会议平台，支持桌面端（Tauri）和 Web 端，提供高质量的实时通讯、屏幕共享和会议录制等功能。
Tauri桌面端支持远程控制功能。

## 🌟 功能特性

### 🎥 核心会议功能
- **实时音视频通讯**：基于 WebRTC 的高质量音视频传输
- **屏幕共享**：支持全屏或应用窗口共享，包含系统音频
- **多人会议**：支持多用户同时在线会议
- **设备管理**：麦克风、摄像头开关，前后摄像头切换
- **房间管理**：自动生成 6 位房间码，支持加入现有房间

### 🛠️ 进阶功能
- **远程协助**：请求控制对方桌面（需要 Tauri 桌面环境）
- **会议录制**：录制会议内容，支持视频下载
- **实时聊天**：文字聊天和快速消息提示
- **说话检测**：实时显示说话状态和音频电平

### 📱 多端适配
- **Web 端**：Chrome、Firefox、Edge 等现代浏览器
- **桌面端**：基于 Tauri 的跨平台桌面应用（Windows、macOS、Linux）
- **移动端**：响应式设计，适配手机和平板，前后摄像头支持 `兼容性考虑摄像头切换使用了稳妥方案，会遍历所有可用的摄像头/焦段，所以部分机型摄像头切换需要多按几下`

## 🏗️ 技术栈

### 前端
- **Vue 3** + **TypeScript** + **Composition API**
- **Vite** - 构建工具和开发服务器
- **Tailwind CSS** - 现代化 CSS 框架
- **Pinia** - 状态管理
- **Vue Router** - 路由管理
- **Socket.io-client** - WebSocket 通信

### 后端信令服务器
- **Node.js** + **Express**
- **Socket.io** - 实时双向通信
- **WebRTC 信令** - ICE/STUN/TURN 服务协调

### 桌面端
- **Tauri** - 轻量级桌面应用框架
- **Rust** - 系统级后端
- **Windows/macOS/Linux** 跨平台支持

### WebRTC 配置
- **STUN/TURN 服务器**：Cloudflare、Google、自定义服务器
- **音频处理**：回声消除、噪音抑制、自动增益控制
- **视频优化**：自适应码率、分辨率调整

## 📁 项目结构

```
WebRTCMeeting/
├── MeetingAPP/                    # Tauri 桌面版源码
│   ├── src/
│   │   ├── components/           # Vue 组件
│   │   │   ├── SettingsModal.vue # AI 设置模态框
│   │   │   ├── VideoPlayer.vue  # 视频播放器组件
│   │   │   └── room/            # 会议室相关组件
│   │   ├── composables/         # 组合式函数
│   │   │   └── useWebRTC.ts     # WebRTC 核心逻辑
│   │   ├── views/               # 页面视图
│   │   │   ├── HomeView.vue     # 首页（创建/加入房间）
│   │   │   └── RoomView.vue     # 会议室页面
│   │   ├── stores/              # 状态管理
│   │   ├── utils/               # 工具函数
│   │   │   ├── audioConverter.ts # 音频格式转换
│   │   │   ├── globalAudio.ts   # 全局音频上下文
│   │   │   └── llm.ts           # AI 功能集成
│   │   └── router/              # 路由配置
│   ├── src-tauri/               # Tauri 后端（Rust）
│   │   ├── src/
│   │   │   ├── lib.rs           # 核心逻辑
│   │   │   └── main.rs          # 入口文件
│   │   └── tauri.conf.json      # Tauri 配置
│   ├── public/                  # 静态资源
│   └── package.json             # 前端依赖
├── server/                      # WebSocket 信令服务器
│   └── index.js                 # 服务器主文件
├── src/                         # Web 版本源码（与 MeetingAPP/src 相同）
└── package.json                 # 根项目配置
```

## 🚀 快速开始

### 环境要求
- **Node.js** 18+ 或更高版本
- **pnpm** 8+（推荐）或 npm/yarn
- **Rust** 1.70+（仅桌面端开发需要）
- **Tauri CLI**（仅桌面端开发需要）

### 安装步骤

1. **克隆项目**
   ```bash
   git clone <repository-url>
   cd WebRTCMeeting
   ```

2. **安装依赖**
   ```bash
   # 安装根项目依赖
   pnpm install
   
   # 进入 MeetingAPP 目录安装前端依赖
   cd MeetingAPP
   pnpm install
   
   # 安装 Tauri 依赖（可选，仅桌面端开发）
   cargo install tauri-cli
   ```

3. **配置环境变量**
   复制 `.env.example` 文件（如果存在）或创建 `.env` 文件：
   ```env
   #websocket后端地址
   VITE_WS_URL=http://localhost:3000
   ```

### 启动开发服务器

#### Web 版本
```bash
# 启动前端开发和 WebSocket 信令服务器
pnpm dev

```

#### 桌面版本
```bash
# 在 MeetingAPP 目录下启动 Tauri 开发模式
cd MeetingAPP
pnpm tauri dev
```

默认访问地址：
- Web 端：http://localhost:5173
- 信令服务器：http://localhost:3000

## 📖 使用说明

### 1. 创建或加入会议
1. 在首页输入您的名字
2. 点击「创建房间」生成新会议室
3. 或输入房间码点击「加入房间」

### 2. 会议室功能
- **音视频控制**：底部控制栏切换麦克风/摄像头
- **屏幕共享**：点击屏幕共享按钮开始/停止
- **聊天功能**：右侧边栏切换到聊天面板
- **成员管理**：查看在线成员和状态

### 3. 高级功能
- **远程协助**：在成员列表中点击「请求控制」
- **会议录制**：点击录制按钮开始/停止录制

## ⚙️ 配置说明

### WebRTC 服务器配置
编辑 `MeetingAPP/src/composables/useWebRTC.ts` 中的 ICE 服务器配置：
**`注意ice服务器并不是越多越好，两三个能确定连通的服务器能加快信令协商速度`**
```typescript
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    // 自定义 TURN 服务器
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'your-username',
      credential: 'your-password'
    }
  ]
}
```

### 部署配置

#### 生产环境构建
```bash
# Web 版本
pnpm build

# 桌面版本
cd MeetingAPP
pnpm tauri build
```

#### 服务器部署
1. 部署信令服务器到 Node.js 环境
2. 配置反向代理（Nginx/Apache）处理 WebSocket
3. 设置 HTTPS 证书（WebRTC 要求安全上下文）

## 🏗️ WebRTC 网络架构

本项目采用 **Mesh（网状/全连接）拓扑结构** 实现多人会议。

### Mesh 架构特点

#### ✅ 优点
- **低延迟**：媒体数据点对点直接传输，无需服务器中转
- **部署简单**：无需部署昂贵的媒体服务器（SFU/MCU）
- **隐私性好**：音视频流不经过第三方服务器
- **成本低廉**：服务器仅作为信令转发，带宽消耗低

#### ⚠️ 局限性
- **客户端压力**：每个用户需要同时上传多路视频（N-1路）
- **带宽限制**：建议单房间不超过 **4-6人**，否则上行带宽可能成为瓶颈
- **设备性能**：解码多路视频对客户端 CPU/内存要求较高

### 适用场景

| 场景 | 适用性 | 建议人数 |
|------|--------|---------|
| 小型团队会议 | ✅ 非常适合 | 2-4人 |
| 一对一通话 | ✅ 完美支持 | 2人 |
| 家庭/朋友视频 | ✅ 适合 | 2-6人 |
| 大型 webinar | ❌ 不推荐 | >6人 |
| 直播间 | ❌ 不适用 | 1对多 |

## 🌐 浏览器兼容性

### 支持的浏览器及版本

| 浏览器 | 最低版本 | 支持程度 | 说明 |
|--------|---------|---------|------|
| **Chrome** | 80+ (2020) | ✅ 完全支持 | 推荐使用，所有功能正常 |
| **Edge** | 80+ (2020) | ✅ 完全支持 | Chromium内核版本 |
| **Firefox** | 76+ (2020) | ✅ 完全支持 | 所有功能正常 |
| **Safari** | 14.0+ (2020) | ⚠️ 部分支持 | 屏幕共享功能受限 |

### 移动端支持

| 平台 | 浏览器 | 最低版本 | 支持程度 |
|------|--------|---------|---------|
| **Android** | Chrome | 80+ | ✅ 完全支持 |
| **Android** | Firefox | 79+ | ✅ 完全支持 |
| **Android** | Samsung Internet | 13.0+ | ⚠️ 部分支持 |
| **iOS** | Safari | 14.0+ | ⚠️ 基础支持 |
| **iOS** | Chrome/Firefox | 最新版 | ⚠️ 基础支持 |

### 功能兼容性详情

| 功能 | Chrome | Edge | Firefox | Safari | iOS Safari |
|------|--------|------|---------|--------|------------|
| 音视频通话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 屏幕共享 | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| 会议录制 | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| 前后摄像头切换 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 音频混音 | ✅ | ✅ | ✅ | ✅ | ✅ |

> **注意**：远程控制功能仅在 **Tauri 桌面端** 可用，其他端不支持。屏幕共享和会议录制移动端不支持

### 技术依赖说明

本项目依赖以下 Web 标准 API：

- **WebRTC API**: `RTCPeerConnection`, `RTCDataChannel`
- **Media Capture**: `getUserMedia()`, `getDisplayMedia()`
- **Media Recording**: `MediaRecorder`
- **Web Audio**: `AudioContext`, `AnalyserNode`, `MediaStreamAudioDestinationNode`
- **Fullscreen API**: 用于全屏会议模式 **iOS端不支持**

项目使用 [`webrtc-adapter`](https://github.com/webrtc/adapter) 库来处理浏览器差异，确保更好的跨浏览器兼容性。

### iOS 特殊说明

由于 iOS 系统限制：
- **第三方浏览器**: iOS 上的 Chrome/Firefox 仍使用 WebKit 内核，与 Safari 限制相同
- **自动播放策略**: 可能需要用户交互才能播放音频

### 已知问题

1. **部分浏览器插件**（如 WebRTC Leak Shield、某些广告拦截器）可能会阻止 WebRTC 连接，请暂时禁用此类插件
2. **Safari 14.0** 以下版本不支持 `RTCRtpSender.replaceTrack()`，摄像头切换功能可能异常