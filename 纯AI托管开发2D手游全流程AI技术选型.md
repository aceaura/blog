# 纯 AI 托管开发 2D 手游：Unity + unity-mcp + Codex 全流程 AI 技术选型

调研日期：2026-08-24。方法：8 环节并行扇出调研（8/8 成功，192 次联网取证）+ 主 agent 源码级一手取证（unity-mcp 官方工具目录与 GitHub 源码树当日抓取）+ 8 论断 × 2 视角对抗性验证（17/17 成功，原始措辞全部未存活，实质修正已全部回写）。这是三部曲的第三篇——前两篇分别回答了「three.js 能不能做手游」和「哪个游戏框架最适合 AI 托管开发」，结论是 Unity + unity-mcp；本篇回答接下来的问题：**选定框架之后，每个环节用什么 AI 技术，才能把 2D 手游的完整流程打通。**

前提设定：Unity + [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp)，OpenAI Codex 为主编程 agent，2D 手机游戏，目标是「纯 AI 托管」——人只下需求和验收，写码、搭场景、产资产、跑测试、出包全由 agent 闭环。

---

## 结论摘要

**全链路每个环节都有可用的 AI 技术组合，能打通；但「打通」≠「无人值守」。** 两个最薄弱环节：① 骨骼动画的绑骨/蒙皮（半自动上限，建议保留人工）；② unity-mcp + Codex 的工程稳定性（unity-mcp 有 92 个 open issue、Codex 的 MCP 集成有多个已知 bug，需要人盯与降级预案）。

| # | 环节 | 推荐 AI 技术组合 | 置信度 |
|---|------|----------------|--------|
| 1 | 编排层 | **Codex CLI**：`~/.codex/config.toml` 配 `[mcp_servers]`，stdio 连 unity-mcp；AGENTS.md 写工程纪律；固定 CLI 版本 | 通道已验证，稳定性存疑 |
| 2 | 引擎操作 | **unity-mcp v10.1.2**（13,607★）：47 工具 + `execute_code` 逃生舱；2D 专用件缺位是常态 | 工具清单源码级已验证 |
| 3 | 策划/数值/内容 | LLM 产数据不产逻辑：数值/关卡/文案全落 ScriptableObject/JSON + 仿真校验 | 方法论已验证 |
| 4 | 2D 美术 | **fal.ai 一站式**：FLUX 生成 + BiRefNet 去背 + LoRA 保一致性；透明背景多路线并列 | 组合已验证 |
| 5 | 2D 动画 | **程序化优先**（PrimeTween + AnimatorController 代码生成）；骨骼选 Rive 或 Spine | 程序化路线已验证 |
| 6 | 音频 | 音乐 Stable Audio API / ElevenLabs Music；SFX ElevenLabs；语音 OpenAI/Azure TTS | API 与条款方向已验证 |
| 7 | 测试闭环 | UTF + run_tests 进 CI；截图+VLM 视觉断言**仅本地** | 闭环结构已验证，CI 视觉段被证伪 |
| 8 | 构建发布 | GameCI + fastlane + 双商店 API；iOS 签名必须 macOS runner；国内四渠道有官方 API | 链路已验证，多处语义被修正 |

贯穿性纪律（比单点工具更重要）：

1. **资产管线即代码**：所有美术/音频生成写成可重跑的脚本（prompt + seed + 模型版本入库），agent 才能迭代资产而不是一次性产出。
2. **execute_code 是主链路的一部分**：2D 专用工具缺位意味着大量操作要走「Codex 写一次性编辑器 C# → unity-mcp execute_code 执行」，要把这个模式固化进 AGENTS.md，而不是当作例外。
3. **双层验证**：逻辑断言（Unity Test Framework，可进 CI）与视觉断言（截图 + VLM，仅本地编辑器）分开设计，别指望一套测试两头跑。

---

## 一、编排层：Codex CLI 驱动 unity-mcp

### 配置通道（已验证）

Codex CLI 的 MCP 配置在 `~/.codex/config.toml`（或项目级 `.codex/config.toml`），用 `[mcp_servers.<name>]` 表声明，`command/args` 走 stdio；Streamable HTTP 传输需 `experimental_use_rmcp_client = true`。unity-mcp 的 README 一手确认 Codex 在支持客户端列表里。典型配置：

```toml
[mcp_servers.unity-mcp]
command = "<unityProjectPath>/Library/mcp-server/osx-arm64/gamedev-mcp-server"
args = ["port=8080", "client-transport=stdio"]
```

TUI 里 `/mcp` 可验证连接。Codex CLI 需 v0.2.0+ 才有 MCP 支持，v0.147（2026-08）支持 MCP 2026-07-28 协议。

### 稳定性警示（对抗验证强化）

openai/codex 仓库 issue 量极大，MCP 相关已知问题包括：工具列表与线程状态不一致（#31374，注意这是 Desktop 端问题，不能简单等同于 CLI）、升级后 agent「忘记」如何调 MCP 工具（#18233）。安全方面 CVE-2025-61260 影响 **≤0.23.0**——恶意仓库可借项目级 `.codex/config.toml` 自动加载 MCP 注入命令，必须升级，且对第三方仓库的项目级配置保持警惕。

### headless / CI 模式

`codex exec` 支持 `--json`（JSONL 输出）、`--ephemeral`、`--full-auto` / `--ask-for-approval never`。已知坑：

- 内部命令失败时进程仍 exit 0（#15536）——**CI 里必须解析 JSONL 输出判断成败**，不能信退出码；
- 无 TTY 环境可能静默崩溃（#19945）——用 `script -qfc` 伪终端 workaround；
- 官方 `openai/codex-action@v1` 曾因 CLI 0.84.0 引入 Landlock 沙箱变更导致 CI 集体 `Permission denied`（#9269）——**固定 CLI 版本是硬纪律**，`@v1` 自动拉新不可控。

### AGENTS.md

分层合并（全局 → 项目根 → 当前目录），默认总大小上限 32 KiB，`/init` 可自动生成。**未发现公开的 Unity/C# 专用 AGENTS.md 范例**——这份要自己写，本文最后一节给出应包含的内容清单。

来源：[Codex CLI MCP 配置指南（Tembo）](https://www.tembo.io/blog/codex-cli-mcp)、[Pieces 的 Codex MCP 文档](https://docs.pieces.app/products/mcp/openai-codex-cli)、[codex exec CI 指南](https://www.developersdigest.tech/blog/codex-exec-ci-headless-guide)、[openai/codex issues](https://github.com/openai/codex/issues)

---

## 二、引擎操作层：unity-mcp v10.1.2 能力边界（源码级取证）

这一层是整个方案的地基，我做了逐文件源码取证：抓取官方工具目录页 + GitHub `Server/src/services/tools` 源码树（2026-08-24，v10.1.2，13,607★，2026-08-07 仍在推送）。

### 47 个工具全景

| 工具组 | 数量 | 工具 | 对 2D 手游的意义 |
|--------|-----|------|------------------|
| core | 30 | manage_scene / manage_gameobject / manage_components / manage_prefabs / manage_asset / manage_material / manage_camera / manage_build / manage_packages / manage_editor / read_console / validate_script / script_apply_edits / batch_execute … | 场景/对象/组件/prefab 全 CRUD；`manage_build` 可触发构建；`batch_execute` 批量提速 |
| scripting_ext | 2 | **execute_code**、manage_scriptable_object | execute_code = 编辑器内执行任意 C#，万能逃生舱；ScriptableObject 是数值配置表的自动化钥匙 |
| asset_gen | 5 | generate_image / generate_audio / generate_model / import_model / import_model_file | 图像（fal.ai、OpenRouter，自带 key）与音频（fal.ai）生成并直导 Unity；3D 模型对 2D 项目用不上 |
| animation | 1 | manage_animation | Animator 控制与 AnimationClip 创建 |
| testing | 2 | run_tests、get_test_job | 异步跑 Unity Test Runner，轮询 job 取结果 |
| ui | 1 | manage_ui | **仅 UI Toolkit（UXML/USS/UIDocument），不含 uGUI Canvas** |
| vfx | 3 | manage_shader / manage_texture / manage_vfx | Shader、程序化纹理、粒子系统 |
| profiling | 1 | manage_profiler | Profiler 会话、计数器、内存快照 |
| docs | 2 | unity_docs、unity_reflect | 查官方文档、反射活体 API——agent 自查 Unity API 的抓手 |
| probuilder | 1 | manage_probuilder | 3D 建模，2D 项目基本用不上 |

### 关键边界（对抗验证与源码双重确认）

- **无稳定版 Sprite 专用工具**。第三方聚合页流传的 `manage_sprite`（切片/图集）只出现在未合并 PR（#1338 仍 open）；Tilemap、PSB 绑骨同样没有专用工具。这些都要走 manage_asset + execute_code 兜底。
- **截图能力存在**：`manage_camera` 有 screenshot / screenshot_multiview 动作（manage_scene.py 源码中的交叉引用字符串证实）——agent 视觉闭环有原生抓手。
- **generate_image 的 transparent 参数只是导入标记**。源码注释原文：fal/FLUX 与 OpenRouter 当前模型无生成级透明，该参数仅设置 Unity 的 alpha-is-transparency 导入旗标；**remove_background 动作在本版本显式 Unsupported，直接返回错误**（我抽验源码证实——这是对抗验证抓出来的，我最初信了工具目录的字面）。
- **uGUI 缺口**：manage_ui 只覆盖 UI Toolkit。2D 手游主流仍是 uGUI Canvas，只能靠 manage_components 设属性或 execute_code。
- **成熟度警示**：92 个 open issue，与自动化直接相关的包括 manage_build 被「场景未保存」对话框阻塞、domain reload 后 stdio 重连拨死端口、命令自动发现给每次 domain reload 加约 9 秒、关闭一个交互实例会停掉所有实例共享的 HTTP MCP server。**无人值守构建要做好卡住检测与重启预案**。

### 与替代方案的位置

- Unity 官方 AI Assistant（com.unity.ai.assistant）：Unity 6+ 专属、约 15 个粗粒度工具、需 Unity Cloud 账号、内置 Muse 生成；CoplayDev 覆盖 Unity 2021.3 → 6.x、完全本地、47 个细粒度工具、开源 MIT。
- IvanMurzak/Unity-MCP：AI Skill + MCP 思路，另有独立扩展包 [Unity-AI-Tilemap](https://github.com/IvanMurzak/Unity-AI-Tilemap/)、Unity-AI-Animation——**CoplayDev 的 2D 缺口可以从这里补**。

---

## 三、策划 / 数值 / 内容生产

- **GDD → 任务**：学术验证路径存在——从 GDD 自动抽取规范生成 Unity C# 模板（[arXiv 2509.08847](https://arxiv.org/abs/2509.08847)，评分 4.8/5）、GDD → User Stories + AQUSA 质量评估 + 反馈重生成（UQAC 2025 硕士论文）。落地做法：GDD 由人审定稿，Codex 拆 user story 逐条实现。
- **数值策划（关键纪律）**：**数据驱动**——武器/敌人/难度/平衡表全部落 ScriptableObject 或 JSON/CSV，LLM 只生成和修改数据，不生成平衡逻辑。数值验证用仿真自玩 + 搜索：[RuleSmith（arXiv 2602.06232）](https://arxiv.org/html/2602.06232v1) 用多智能体自玩 + 贝叶斯优化搜 12 维规则空间，把胜率差压到约 0%（学术线索，未投产验证）。完整性批判强调：LLM 有数值漂移、虚构公式的问题，**必须配数值校验器**（schema 合法性 + 仿真回归）后再入库。
- **关卡生成**：WFC/GA 混合 2D 关卡生成（ICCS 2025，8.45s/张、无效率 10.1%）等学术路线 + 可通关性自动验证（洪水填充/求解器）。LLM 适合做评审与参数调优，不适合直接摆关卡。
- **本地化**：[IJEMIN/Unity-Localization-AI](https://github.com/IJEMIN/Unity-Localization-AI) 在 Unity Localization 包上接 GPT 批量翻译 String Table（小项目，兼容性存疑）；自写脚本调 LLM API 批量翻译同样是低风险做法。
- **对话/剧情**：LLM 生成对话树 + 动态结构化记忆保一致性（[arXiv 2510.13363](https://arxiv.org/html/2510.13363v1)，学术）；敏感内容审核用规则 → 快速分类器 → LLM 复核的级联（成本可降 70–90%，商业方案自称）。

---

## 四、2D 美术管线

对抗验证推翻了我最初的「GPT-Image-2 是唯一原生透明背景方案」——修正后的选型矩阵是多路线并列：

| 需求 | 方案 | 说明与定价 |
|------|------|------------|
| 通用精灵/立绘/背景 | fal.ai FLUX 2 | Pro $0.05/张、Dev $0.025/张；unity-mcp generate_image 原生提供方，可直导 Unity |
| 原生透明背景 | Ideogram V3 Transparent / Recraft / GPT-Image-2（preview）/ fal.ai 的 Qwen-Image-Layered | 多路线并列；GPT-Image-2 透明仍 preview 且编辑端点会把透明度当重绘 |
| 矢量 UI/图标 | **Recraft** | 原生 SVG，矢量天然无背景；有 Brand Kit 风格锁定 |
| 角色/风格一致性 | **fal.ai 托管 Flux LoRA 训练** + 参考图/IP-Adapter | 约 $0.008/step、$8/次量级（定价来源互相矛盾，存疑标注）；一致性是游戏资产的核心工程问题 |
| 去背后处理 | **rembg**（MIT，内置 BiRefNet，Docker 自托管） | 零边际成本；商业托管 useknockout $0.02/张、Apify $0.007/张起 |
| 像素风/序列帧 | PixelLab（有 API，含八方向角色生成）/ SpriteFusion / Retro Diffusion | 专用工具，未实测（未证实线索） |
| 进 Unity | unity-mcp generate_image 直导；或 AssetPostprocessor 脚本（TextureType=Sprite）+ SpriteAtlas API 自动打包 | [Unity 官方 SpriteAtlas 文档](https://docs.unity3d.com/2022.3/Documentation/Manual/SpriteAtlasWorkflow.html)；TexturePacker CLI 是成熟替代 |

两个值得注意的实测细节：

- Gemini 2.5 Flash Image（nano banana）**不真支持透明背景**——提示词要 transparent 时往往给棋盘格或白底伪透明（[Google 官方论坛确认](https://discuss.ai.google.dev/t/unable-to-create-transparent-pngs/92868)）；它在角色/动画帧一致性上反而被社区评为领先，所以正确用法是「Gemini 出一致性帧 + BiRefNet 去背」。
- **管线纪律**：prompt + seed + 模型版本全部入库，生成脚本化，可重跑可 diff；AI 资产的商用权利与版权归属按各平台 ToS 逐家确认（完整性批判强调，特别是准备上架时）。

---

## 五、2D 动画管线（全链路最弱环节）

- **程序化动画（推荐主力，agent 100% 自主）**：PrimeTween（零分配、销毁安全）/ DOTween / LeanTween 纯代码驱动位移/旋转/缩放/颜色；Animator Controller 经 `UnityEditor.Animations` 命名空间**完全代码生成**（[官方文档](https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Animations.AnimatorController.html)；复杂 blend tree 与嵌套状态机需 SerializedObject workaround——验证修正）。unity-mcp 的 manage_animation 正好覆盖这条线。
- **骨骼动画（半自动上限）**，按 agent 友好度排序：
  - **Rive**：runtime-first、状态机代码驱动、数据格式自动化友好——对抗验证提出的更优替代，对 agent 最友好；
  - **Spine**：JSON 格式 + 官方 CLI（export/import/batch），但 CLI 需 per-instance 付费授权、图像/视频导出依赖 OpenGL（验证修正）；社区有 spine-MCP（小项目，未验）；
  - **DragonBones**：免费，**有官方 dragonbones-tools CLI**（验证修正——扇出调研「无 CLI」的说法不成立）；
  - Unity 2D Animation (PSB)：骨骼可经 SpriteBone API / SpriteDataAccessExtensions 程序化读写（验证修正），但外部 AI 直接生成 PSB 不现实。
- **AI 自动绑骨/蒙皮**：UniRig（SIGGRAPH 2025）、ASMR（Eurographics 2025）主攻 3D mesh，**无面向 2D 游戏的即开即用 API**；Armature 号称 AI 辅助 2D 绑骨（2026-08 报道，未证实线索）。图生视频（可灵/Runway/Pika）优化自然运动、像素会漂移，不能直接当锁帧精灵序列帧。
- **结论**：原型期全部程序化动画；需要骨骼表现力的角色，**绑骨/蒙皮是全流程唯一建议保留人工（或外包）的环节**。

---

## 六、音频管线

| 用途 | 推荐 | 授权要点（存疑标注，商用前读条款原文） |
|------|------|------------|
| 背景音乐 | **Stable Audio API**（3.0，约 $0.26/次，最长 6 分钟）；或 **ElevenLabs Music API**（POST /v1/music，约 900 credits/分钟） | Stable Audio 的 Community License（年收入 <$1M）针对自托管权重，**API 输出的商用权利由平台订阅条款决定**（验证修正，两者别混）；ElevenLabs Music 对游戏的限制在 2026-05 更新的 Model-Specific Terms，界定词是「Studio Games」多平台商业化，单平台游戏自助计划可用（验证修正） |
| 音效 SFX | **ElevenLabs SFX API**（约 $0.12/分钟） | 付费计划可在游戏内作为组成部分商用，禁止单独转售 SFX 库 |
| 角色语音 | **OpenAI TTS**（tts-1 $15/1M 字符）或 **Azure Neural TTS**（约 $16/1M 字符，免费 50 万字符/月） | 一般允许商用，禁止模拟真实人物；edge-tts 免费但走 Edge 服务端点，商用有 ToS 风险 |
| 明确排除 | Suno / Udio | Suno 2026-07 起有**受邀合作伙伴 API 计划**（[Digital Music News](https://www.digitalmusicnews.com/2026/07/03/suno-is-opening-an-api-partner-program/)），但无自助公开 API，第三方 cookie 封装有 ToS 风险；Udio 无官方 API 且条款把生成作品权利留在平台方；MusicGen/MMAudio 权重 CC-BY-NC 不可商用 |
| 进 Unity | AssetDatabase.ImportAsset + AudioImporter 脚本化 | load type / compression / loop 均可脚本设置；AudioMixer Group 不能运行时创建，需预配置 |

unity-mcp 的 generate_audio 走 fal.ai 模型，可以作为 SFX/短乐的零配置起步方案；量产建议直连上述 API 写进资产管线脚本。

---

## 七、测试与验证闭环

这是「纯 AI 托管」的命门——agent 必须能自己「跑起来看结果」。对抗验证修正后的**双层设计**：

### 逻辑断言层（可进 CI）

- Unity Test Framework 分 Edit Mode（可访问 Editor API）与 Play Mode（协程测运行时）（[官方文档](https://docs.unity3d.com/Packages/com.unity.test-framework@1.4/manual/edit-mode-vs-play-mode-tests.html)）；unity-mcp `run_tests` 异步跑 Test Runner，`get_test_job` 轮询取结果。注意它是单任务模型，有 stuck-job 清理与 editor_unfocused 阻塞（验证修正）——并发跑测试不要指望。
- CI 里 GameCI unity-test-runner 跑同一套测试。

### 视觉断言层（仅本地编辑器）

- `manage_camera` screenshot 或 `ScreenCapture.CaptureScreenshot` 截 GameView → 传 VLM 做断言。VideoGameQA-Bench 证明「视觉单元测试」方向可行（能检出漂浮车辆、武器穿模、UI 缺失），但对小物体状态、时序敏感交互仍不可靠。
- **关键修正：GameCI 的 headless Docker 容器没有 GPU/显示设备，ScreenCapture 截图黑屏**——视觉断言只能在本地编辑器环境跑，不能进 CI。别设计「同一套测试本地 CI 两头跑」。

### 输入模拟

- Input System 自带 TestFramework：设备注入用 Press/Release（桌面）/**BeginTouch/EndTouch/MoveTouch（移动端触摸——验证修正，别把桌面 API 泛化到手游）**；`InputEventTrace` + ReplayController 可录制回放输入序列。
- 真机层：Firebase Test Lab（Game Loop 测试）/ AWS Device Farm 补真机回归；AltTester / Appium 是 Unity 专用自动化的补链工具（完整性批判提出，扇出遗漏）。
- 更激进的方向：Unity ML-Agents 官方把「automated testing of game builds」列为用例，RL agent 自主探索关卡找边缘 bug（商业方案自称减少 30–50% 回归 QA 工时——自称，存疑）。

**端到端现状警示**：未检索到「Codex + unity-mcp + VLM 断言」的公开端到端实践案例。这套闭环要自己搭，并留人工抽检。

---

## 八、构建与发布

### 构建

- Unity CLI：`-batchmode -quit -projectPath -executeMethod <Class.Method>` + BuildPipeline.BuildPlayer（[官方文档](https://docs.unity3d.com/6000.5/Documentation/Manual/build-command-line.html)；一次调用只能一个 buildTarget）。
- GameCI `unity-builder@v4`（我当日抓取官网确认 v4 现行）：支持 AAB/APK 导出与 keystore secrets。
- **许可注意（验证修正）**：Unity 自 2023 年起停止 Personal 许可的手动激活，GameCI 的 ULF secrets 方案对 Personal 不再可靠——Pro/Plus 用 `UNITY_SERIAL`；用 Personal 的话激活这步要先实测。
- iOS：Linux runner 只能导出 Xcode 工程，**签名与 IPA 必须 macOS runner + fastlane match**（证书管理）；只给 Unity-iPhone target 配 Provisioning Profile、关闭 Automatically Sign、固定 Xcode 版本。

### 商店提交

- **Google Play**：`edits.tracks.update` 设 status 后**必须再调 `edits.commit`** 才生效（验证修正）；`completed` 的语义是「分阶段发布已全量」，不是「设置即自动发布」。新应用必须 AAB。
- **App Store**：fastlane deliver 可上传二进制+素材+元数据 + `submit_for_review`；`automatic_release` 有长期 bug（fastlane #19797）；审核后选手动发布的话，fastlane 无法完成最后一步，要用 App Store Connect API `appStoreVersionReleaseRequests` 补一刀。
- **国内渠道**：[华为 app-submit API](https://developer.huawei.com/consumer/en/doc/appgallery-connect-references/agcapi-app-submit-0000001158245061)、[小米 dev/push 一次传包+素材](https://dev.mi.com/distribute/doc/details?pId=1134)、[OPPO 传包 API](https://open.oppomobile.com/new/developmentDoc/info?id=10998)（需先后台建应用、限主账号）、[vivo API 管理](https://dev.vivo.com.cn/documentCenter/doc/281) 均有官方发布通道；公开示例多为 APK，AAB 支持待核实；应用宝自动化公开信息最少（未证实线索）。
- **商店素材**：fastlane snapshot + frameit 自动截图套壳仍是主流 CI 管线；AI 生成 icon/文案可行。
- **版本串联**：semantic-release + fastlane plugin 解析 conventional commit 生成版本号/changelog → 脚本回写 PlayerSettings → GameCI 构建 → 双商店上传。完整示例参考 [starburst997/unity-github-actions](https://github.com/starburst997/unity-github-actions)。
- **合规人工节点（完整性批判强调）**：商店 AI 生成内容披露、隐私问卷、年龄分级、签名证书管理——这些留人工，不要自动化掉。

---

## 九、打通「完整游戏流程」还缺的环节

完整性批判指出扇出没覆盖、但完整流程绕不开的五块：

1. **性能工程化**：SpriteAtlas、ASTC/ETC2 压缩、draw call 预算、对象池、GC 纪律——写进 AGENTS.md 让 Codex 按规则执行，用 unity-mcp manage_profiler 采样验证。
2. **资产版本控制**：Git LFS；AI 批量资产的 diff/审阅/回滚流程（生成脚本入库正好解决一半）。
3. **后端与商业化**（若联网）：账号/存档/排行榜（UGS/PlayFab/Firebase）、IAP、广告聚合、分析、崩溃上报——扇出未覆盖，需单独调研。
4. **热更新**：Addressables 分包 / HybridCLR——长线运营需要，设计初期就要决定。
5. **合规**：AI 披露、隐私、分级、证书——半自动，留人工节点。

---

## 十、对抗性验证记录：我哪里错了

8 论断 × 2 视角（事实一致性 / 选型适用性，验证 agent 可联网查证），**原始措辞 0 条存活：8 条全部被反驳**。这轮反驳质量很高，抓出多个实质错误：

| # | 我的原始论断 | 反驳抓到的错 |
|---|-------------|-------------|
| 1 | Codex 配 unity-mcp（CVE 影响 <0.23.0） | 边界错了，是 **≤0.23.0**；#31374 是 Desktop 端问题不能等同 CLI；unity-mcp 的 HTTP 传输未经官方确认为 Streamable HTTP |
| 2 | 47 工具 + execute_code 足以覆盖主链路 | 工具实为 48 个（含 4 个元工具）；「execute_code 兜底 = 主链路覆盖」是推断跳跃，一次性 C# 的稳定性撑不起「主链路」三个字 |
| 3 | asset_gen 闭环，fal/OpenRouter 无生成级透明 | 过度概括——fal 有 Qwen-Image-Layered/GPT Image 2、OpenRouter 有 gpt-image-1 可原生透明；**remove_background 在本版本显式 Unsupported**（我抽验源码证实） |
| 4 | GPT-Image-2 是唯一原生透明方案 | Ideogram V3 Transparent、Recraft 同样原生透明，「唯一」不成立 |
| 5 | 音频排除 Suno/Udio（无官方 API） | Suno 2026-07 已有受邀合作伙伴 API 计划；ElevenLabs Music 的游戏限制在 Model-Specific Terms 且按「Studio Games」界定，不是一刀切 |
| 6 | Spine 是最可自动化的骨骼方案 | Rive 更代码化；**DragonBones 有官方 CLI**（扇出的说法被推翻）；Spine CLI 需授权+OpenGL |
| 7 | 测试闭环可行（同一套测试本地 CI 两头跑） | **GameCI headless 无 GPU 截图黑屏，视觉断言不能进 CI**；移动触摸注入是 BeginTouch/EndTouch/MoveTouch 不是 Press/Release |
| 8 | 构建发布全自动（Google Play status=completed 即发布） | 必须 edits.commit 才生效、completed 语义纠偏；Personal 许可 ULF 方案 2023 年起不可靠；fastlane automatic_release 有长期 bug |

规律和前两次调研一致：底层一手事实基本站得住，错都在「过度概括」和「把存在性当成可用性」。

---

## 十一、落地建议

**必须先自己回答的输入**：单机还是联机？付费模式（买断/IAP/广告）？目标商店（App Store/Google Play/国内渠道）？Unity 版本与渲染管线？动画表现力要求（决定要不要保留人工绑骨）？

**Unity 项目 AGENTS.md 应包含**（调研未找到现成范例）：Unity 版本与包清单、Force Text 序列化、目录约定（Scripts/Art/Audio/Config 分离）、数值全部走 ScriptableObject/JSON、性能预算（draw call/图集/压缩格式）、测试命令（edit/play mode 与截图断言分开）、execute_code 使用规范、禁止直接改 Library/。

**垂直切片落地顺序**：

1. 第 1 周：打通「Codex → unity-mcp → 建场景/写码/跑测试/截图」最小闭环，实测稳定性（重点观察 domain reload 重连、run_tests 阻塞）；
2. 第 2 周：接 fal.ai 美术 + ElevenLabs 音频资产管线，prompt/seed 入库；
3. 第 3 周：GameCI + fastlane 出一个真能装上手机的包。
4. 每一步卡住都先降级到 execute_code/人工，跑通后固化进 AGENTS.md。

---

## 附：调研方法

- 编排：两次 Workflow——8 环节扇出（8/8 成功，192 次工具调用）→ 对抗验证 + 完整性批判（17/17 成功，401 次工具调用），子 agent 全部 haiku、只读。
- 主 agent 一手取证：unity-mcp 官方工具目录页、GitHub 源码树（Server/src/services/tools）、generate_image.py / manage_scene.py 源码、GameCI 官网、ElevenLabs API 文档——全部 2026-08-24 当日抓取。
- 未能访问：developers.openai.com（403，Codex 官方文档依赖第三方转述，置信度已降级标注）。
