# 位流与 ELF 联合烧写标准流程（MicroBlaze 工程）

**性质**：**流程基线**。本文是 [`14_Vivado通用开发流程与比特流新鲜度门禁`](../../ACX720知识库/流程与基线/14_Vivado通用开发流程与比特流新鲜度门禁.md)
的**第三条路**——它只讲了「SRAM `.bit`」与「QSPI `.bin`」两条，**MicroBlaze 的 ELF 那一半是空的**
（doc 14 §7 自己写着"MicroBlaze 工程建立后…"，即当时有意留白）。
**本文不复制 doc 14 / doc 12 的内容**，只补 ELF 这一半。

**主仓库落点**：`设备项目文件/docs/ACX720知识库/流程与基线/16_位流与ELF联合烧写标准流程.md`
（**已落地 2026-10-14**。）

> 🔁 **两处副本的同步纪律**（**不要让它俩悄悄漂移**）：工作区副本
> `%MAIN_REPO%-dsh\docs\FPGA_位流与ELF联合烧写标准流程.md` 与上述主仓库文件**同内容**。
> 改任一处**必须**同步另一处；**同步的方向与"两侧一致性核对结果"写进 §9 沿革**。
> ⚠️ **不把哈希写进本文**：哈希一旦写进被它描述的文件，下一秒就自指过期
> （与 `frozen.json` 不冻自身同一条纪律）。要核对就**现算**：
> `Get-FileHash <两侧路径> -Algorithm SHA256` 比对。
> （本工程已有先例：模板双副本因手工 `Copy-Item` 方向写反而丢过内容 ⟹ 同步要**留核对结果**，不靠记忆。）

**适用**：`microblaze_gnss` / `microblaze_wifi_gnss` / `lab_2_2_11*` / `smart_home`(S8) 等**含 MicroBlaze 的工程**。

---

## 0. 三条铁律（**违反任何一条，都会得到"看起来成功"的假象**）

| # | 铁律 | 为什么 |
|---|---|---|
| **R1** | **改过 RTL / XDC / IP / BD ⟹ 位流必须重建** | `.bit` 只反映写出那一刻的设计。**尤其：`PACKAGE_PIN` 是约束，改引脚不可能"只改 ELF"**（2026-10-14 GNSS 实测：脚位从 A14/A13 改到 A18/A16，必须重综合重实现） |
| **R2** | **顺序永远「先 bit，后 ELF」；断电 ⟹ 两者都要重下** | SRAM 掉电即失。位流里的 BRAM 初值是官方 `mb_bootloop_le.elf`（**bootloop**），**不重烧位流就跑不了本实验固件** |
| **R3** | **默认只写 SRAM**；QSPI 固化是**另一条路**（doc 12），**需单独授权** | 固化后的"自启动成功"与"业务固件正确"是两件事（doc 12 §固化边界） |

> ⚠️ **改固件不是"只重下 ELF"就够**：只重下 ELF 而基线没重启时，
> **XSDB 仍会报成功且显示 CPU Running，但固件其实没跑起来**（实测症状：tick 不归零）。
> 这是本流程要防的**头号假成功**。

---

## 1. 两条可选路径（**按环境与需求选，不要混**）

| | **路径 A：分两步（bit + ELF 各自下载）** | **路径 B：合并位流（**推荐**）** |
|---|---|---|
| 做法 | Vivado 烧 `.bit` → XSCT/JTAG `dow` 下 `.elf` | `updatemem` 把 ELF **合并进** `.bit` → **一次** JTAG 烧写 |
| 需要 XSCT | **需要**（`connect` + `dow` + `con`） | **不需要** |
| 需要 hw_server 活着 | 需要 | 不需要（Vivado 自己管） |
| 断电后 | 重烧 bit **+** 重下 ELF | 重烧合并位流（一步） |
| 适用 | 需要反复改固件、快速迭代 | 一次成型的验收/演示；**XSCT 环境不可用时的正路** |
| 实测出处 | `lab_2_2_11`（2026-10-11 上板闭环） | `microblaze_gnss`（2026-10-14 GNSS 链路 B） |

> 💡 **工程自带脚本名里往往就有第二条路**（如 `prepare_flash_bit.tcl` / `program_merged_jtag.tcl`）。
> **找路之前先读工程自己的 `scripts/`**——比猜环境快得多。

---

## 2. 路径 A：分两步

```text
A1 烧位流（Vivado + JTAG，SRAM）
   命令：vivado -mode batch -source <工程>/scripts/program_<项目>_jtag.tcl
   门：  SRAM_PROGRAM_STATUS=PASS
        且 HW_DEVICE=xc7a35t_0 IDCODE=00000011011000101101000010010011   ← 器件必须对
   ⚠️  脚本收尾若含 disconnect_hw_server + close_hw，会把 hw_server 一起关掉（影响 A2）

A2 确认 hw_server 在监听（**A1 之后最容易踩**）
   门：  netstat -ano | findstr :3121   能看到监听
        没有 ⟹ 先起 hw_server（或用路径 B 绕开）

A3 下载 ELF（XSCT）
   命令：xsct <工程>/scripts/download_elf_xsct.tcl      （内部：connect → targets → rst -processor → dow → con）
   门：  ELF_DOWNLOADED=… 且 ELF_RUN_STATUS=PASS

A4 **可观测性验证（唯一真正的门）**
   见 §4——**工具说成功不算成功**
```

**XSCT 目标名**：写 `*MicroBlaze #*`，**不要**写 `MicroBlaze*`（实测后者匹配不到）。

---

## 3. 路径 B：合并位流（**免 XSCT**）

```text
B1 导出硬件交接（Vivado）
   命令：vivado -mode batch -source scripts/export_hdf_direct.tcl
   门：  GNSS_HDF_EXPORT_STATUS=PASS     产物：build/<项目>.hdf + <项目>.mmi
   ⚠️  .mmi 是 B4 的必需输入（2019.1 从 checkpoint 重开时会丢 BMM_INFO，需按 RAMB36 站点重建）

B2 生成 BSP（**优先 hsi::，不碰 Eclipse**）
   正解：xsct 的 hsi:: 命名空间——open_hw_design → create_sw_design → generate_bsp / generate_app
   坑：  · createhw/createbsp 会拉起 Eclipse，配置区不可写时直接死（"timeout while establishing a connection with SDK"）
         · -app 必须写仓库名 empty_application（写 {Empty Application} 会 not Found）
         · hsi::generate_app 没有 -lang
         · BSP make 需 RDI_PLATFORM=win32（否则 SHELL 落到不存在的 sh.exe）
   备选（仅当 hsi:: 也不可用，且**必须标注为绕行**）：复用已预建的 sdk_workspace + 直接 mb-gcc

B3 编译 ELF
   命令：powershell -File scripts/build_sdk_app.ps1      （直接调 mb-gcc，链接 -lxil -lgcc）
   门：  mb-size 正常输出；ELF 存在且时间戳是**本次**

B4 合并
   命令：updatemem -meminfo <项目>.mmi -data <...>.elf -bit <项目>.bit \
                   -proc <MMI 里的 InstPath，例如 microblaze_gnss_i/microblaze_0> -out <...>_fixed.bit -force
   门：  update_mem completed successfully（0 errors）
   ⚠️  -proc 必须与 .mmi 里的 <Processor InstPath="…"> 逐字一致

B5 烧写（一次跑完 bit+固件）
   命令：vivado -mode batch -source scripts/program_merged_jtag.tcl
   门：  GNSS_MERGED_JTAG_STATUS=PASS（或等价 PASS 行）+ 器件 IDCODE 正确
```

---

## 4. ⚠️「假成功」清单（**本流程存在的理由**）

| # | 假成功 | 症状 | 怎么防 |
|---|---|---|---|
| **1** | **改固件后只重下 ELF**，基线未重启 | XSDB 报成功、CPU Running，**但 tick 不归零、业务没跑** | 一律**先 bit 后 ELF**；或用路径 B 一步到位 |
| **2** | **断电后只下 ELF** | 同样"成功"但无输出 | 断电 ⟹ 位流与 ELF 都重下 |
| **3** | **改引脚却想"只改 ELF"** | 工具全绿、引脚还是旧的 | R1：改 XDC ⟹ **重建位流**；并**打开 checkpoint 核 `PACKAGE_PIN`**（见 §5 门 5） |
| **4** | **烧了旧位流** | 跑旧逻辑 | 位流新鲜度门禁（doc 14 §4）；**注意 direct flow 不判时序/DRC**，必须手工读 `timing_summary.rpt`/`drc.rpt` |
| **5** | **串口开头乱码** | 头几个字节是乱码 | FPGA 配置/固件启动瞬态的线路噪声，**不是缺陷**；从首行 banner 往后判 |
| **6** | **用错 COM 口** | 读不到、或读到别的设备 | **不得写死 COM 号**：每次 `GetPortNames()` / 按 `VID_1A86` 动态枚举后显式传参。板载 CH340 的 COM 号随插口与枚举顺序变化（历史出现过 COM3/COM8/COM11） |
| **7** | **把"工具退出码 0"当成功** | 脚本报错但 pwsh 退出码 0 | **门要看脚本自己打印的 PASS 行 + 可观测输出**，不看 shell 退出码 |

---

## 5. 验证门（**统一格式：命令 + 期望输出 + 判据**）

| # | 门 | 命令/证据 | 期望 |
|---|---|---|---|
| 1 | 器件正确 | 编程脚本输出 | `HW_DEVICE=xc7a35t_0` + IDCODE `0x0362D093` |
| 2 | 位流新鲜 | 门禁 PASS 或人工比对源/位流时间戳 | 位流不早于任何源 |
| 3 | 时序/DRC（direct flow 必做） | `reports/*_timing.rpt`、`*_drc.rpt` | WNS/WHS 为正、未布线 0、DRC error 0 |
| 4 | 烧写成功 | 脚本 PASS 行 | `SRAM_PROGRAM_STATUS=PASS` / `…MERGED_JTAG_STATUS=PASS` |
| 5 | **引脚落地**（改了 XDC 必做） | `open_checkpoint <post_route.dcp>` → `get_property PACKAGE_PIN [get_ports <port>]` | 与引脚权威表逐字一致 |
| 6 | 固件真的在跑 | **串口首行 banner + 计数器递增** | 例如 `GNSS_BOOT …`/`GNSS_READY …` 且 `tick` 递增、首字节不再乱码 |
| 7 | 业务可观测 | 业务判据（如 `GNSS_RAW` 连续且 `bad=0`、命令回报条数） | 由各工程定义 |

> **门 6 是"假成功"的唯一解药**：只要没有"设备自己在动"的证据，前面所有 PASS 都不算数。

---

## 6. 环境坑速查（都真实踩过）

| 现象 | 根因 | 处置 |
|---|---|---|
| `timeout while establishing a connection with SDK` | `createhw/createbsp` 拉起 Eclipse，配置区不可写 | 用 **`hsi::`** 建 BSP；**不要**据此断定"本机做不了"（见 §7） |
| Vivado 启动报 `[Common 17-741] No write access right to the local Tcl store at 'C'` | 与上条同源（`%USERPROFILE%\.Xilinx` 不可写） | 对 Vivado **不致命**；但**别当成"无害噪声"就跳过**——它暗示同类工具可能致命 |
| `connect -url tcp:localhost:3121` 失败、3121 无人监听 | 前一个 Vivado 脚本 `disconnect_hw_server` 把 hw_server 关了 | 先起 hw_server，或走路径 B |
| `version -short` 报 `bad option` | 2019.1 的 xsct 只认 `-help`/`-server` | 别用 `-short` 探版本 |
| BSP `make` 崩 `0xc0000005` | `RDI_PLATFORM` 为空 ⟹ `SHELL` 落到本 SDK 没有的 `sh.exe` | 设 `RDI_PLATFORM=win32` |
| `xsct.bat` 报"禁止运行脚本"类 | PowerShell 执行策略 | `-ExecutionPolicy Bypass -File`（**只作用于当次进程**，不改持久策略） |
| 中文路径下综合子进程 `TclStackFree` 崩溃 | 中文路径 | 构建在**纯 ASCII 树**；本文所有命令都在 ASCII 路径下执行 |

---

## 7. 🔴 判 `TOOL_ENV_FAIL` 的纪律（**本工程犯过两次同款错误**）

> **"某条路径报错" ≠ "这件事本机做不了"。**

判 `TOOL_ENV_FAIL` **必须**同时给出：

1. **已穷举的替代路径清单**，以及**各自如何失败**；
2. 至少一条**替代路径的失败原文**（不是印象）。

否则会把"一条路被挡"误报成"整条验收线无理由挂起"。
**历史两次同款**：①"Eclipse 配置区只读 ⇒ 本机不能生成 BSP ⇒ 只能换主机"（已被 `hsi::` 证伪）；
②2026-10-14 把同一个报错又标成"沙箱挡死 XSCT"（记忆库当场把①弹回）。
**替代路径成功也要标注**："这是对误判问题的绕行"，别让它变成默认做法。

---

## 8. 各工程实例（**现状，非承诺**）

| 工程 | 路径 | 关键脚本 | 已知边界 |
|---|---|---|---|
| `lab_2_2_11` | A | `scripts/run.bat`（默认只 synth，带 `bit` 才出位流） | 2026-10-11 上板闭环；**该工程就是"先 bit 后 ELF"纪律的来源** |
| `lab_2_2_11_wifi` | A | `build_sdk_app.ps1`（mb-gcc） | 上板顺序固定先 bit 后 ELF；不写 QSPI |
| **`microblaze_gnss`** | **B**（2026-10-14 实测） | `export_hdf_direct.tcl` → `build_sdk_app.ps1` → `updatemem` → `program_merged_jtag.tcl` | 旧 XDC 是**作废脚位 A13/A14**；固件缺 `XUartLite_ResetFifos()` |
| `smart_home`（S8） | 待定 | 待建 | 见 `slices/S8_bd_firmware/TASK.md` |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-14 | 建档（用户提议"位流+ELF 烧写流程标准化"，并指出 `lab_2_2_11_wifi` 也犯过错）。定位为 doc 14 的**第三条路**（ELF 那一半），不复制 doc 12/14。含：三条铁律、A/B 两条路径与逐步验证门、**7 条"假成功"清单**、7 道验证门（含"引脚落地"与"固件真的在跑"）、环境坑速查、**判 `TOOL_ENV_FAIL` 的纪律**（本工程两次同款误判）、各工程实例。实证来源：2026-10-14 GNSS 链路 B 上板（该上板记录目前在工作区草稿层 `smart_home/slices/S0_preflight/RUNLOG_lead_2026-10-14_gnss_chainB.md`，**入库待做**——本行仅作来源说明，不构成主仓库内的可用引用）。 |
| 2026-10-14 | **落库**：工作区 → 主仓库知识库（单向 `Copy-Item`，落地前目标不存在 ⟹ 无覆盖）；同步后两侧一致性核对 **IDENTICAL**。落点 `设备项目文件/docs/ACX720知识库/流程与基线/16_位流与ELF联合烧写标准流程.md`。同时把"同步纪律"里的**哈希**改为"现算 + 只记核对结果"（写死哈希会自指过期）。 |